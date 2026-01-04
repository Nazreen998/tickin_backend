import {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { bookSlot } from "../slot/slot.service.js";

import {
  deductDistributorMonthlyGoalProductWise,
  addBackDistributorMonthlyGoalProductWise,
} from "../../services/goals.service.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const TRIPS_TABLE = process.env.TRIPS_TABLE || "tickin_trips";
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE || "tickin_slot_bookings";
export const getSlotConfirmedOrders = async (req, res) => {
  try {
    // ✅ 1) Scan tickin_slot_bookings where status = CONFIRMED
    const bookingsRes = await ddb.send(
      new ScanCommand({
        TableName: BOOKINGS_TABLE,
        FilterExpression: "#s = :c",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":c": "CONFIRMED" },
      })
    );

    const bookings = bookingsRes.Items || [];

    // ✅ 2) Unique orderIds from bookings
    const orderIds = [...new Set(bookings.map((b) => b.orderId).filter(Boolean))];

    const orders = [];

    // ✅ 3) Fetch each order details from tickin_orders
    for (const orderId of orderIds) {
      const orderRes = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${orderId}`, sk: "META" },
        })
      );

      if (!orderRes.Item) continue;

      const order = orderRes.Item;
      const booking = bookings.find((b) => b.orderId === orderId);

      orders.push({
        orderId,
        distributorName: order.distributorName,
        distributorId: order.distributorId,
        status: order.status,
        items: order.items || [],
        totalQty: order.totalQty || 0,
        grandAmount: order.totalAmount || 0,

        // ✅ slot from bookings table
        slot: {
          bookingId: booking.bookingId,
          companyCode: booking.pk?.split("#")[1] || null,
          date: booking.pk?.split("#")[3] || null,
          time: booking.slotTime,
          pos: booking.pos,
          vehicleType: booking.vehicleType,
        },
      });
    }

    return res.json({ ok: true, count: orders.length, orders });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
/* ==========================
   ✅ Confirm Draft Order
   DRAFT → PENDING (Salesman)
========================== */
export const confirmDraftOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    const existing = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = existing.Item;

    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can confirm" });
    }

    if (order.status !== "DRAFT") {
      return res.status(403).json({ message: "Order already confirmed" });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET #st = :p, confirmedAt = :t",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":p": "PENDING",
          ":t": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "ORDER_CONFIRMED",
      by: user.mobile,
      extra: { role: user.role, note: "Order confirmed by Salesman" },
    });

    return res.json({
      message: "✅ Order confirmed successfully",
      orderId,
      status: "PENDING",
      totalAmount: order.totalAmount,
      distributorName: order.distributorName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Create Order (Direct PENDING)
========================== */
export const createOrder = async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || "").toUpperCase();
    const { distributorId, distributorName, items } = req.body;

    if (
      !(
        role === "SALES OFFICER" ||
        role === "SALES_OFFICER" ||
        role === "MANAGER" ||
         role === "SALES OFFICER_VNR" 
      )
    ) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!distributorId || !distributorName) {
      return res
        .status(400)
        .json({ message: "DistributorId + DistributorName required" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items required" });
    }

    let finalItems = [];
    let totalAmount = 0;
    let totalQty = 0;

    for (const it of items) {
      const pid = String(it.productId || "");
      const productSk = pid.startsWith("P#") ? pid : `P#${pid}`;

      const prodRes = await ddb.send(
        new GetCommand({
          TableName: "tickin_products",
          Key: { pk: "PRODUCT", sk: productSk },
        })
      );

      if (!prodRes.Item) {
        return res
          .status(400)
          .json({ message: `Product not found: ${it.productId}` });
      }

      const prod = prodRes.Item;
      const qty = Number(it.qty || 0);
      if (qty <= 0) {
        return res.status(400).json({ message: "Qty must be > 0" });
      }

      const price = Number(prod.price || 0);
      const itemTotal = qty * price;

      finalItems.push({
        productId: prod.productId, // might be "P#1002"
        name: prod.name,
        category: prod.category,
        price: prod.price,
        qty,
        total: itemTotal,
      });

      totalAmount += itemTotal;
      totalQty += qty;
    }

    const orderId = "ORD" + uuidv4().slice(0, 8);

    // ✅ GOAL DEDUCT (PRODUCT-WISE)
    await deductDistributorMonthlyGoalProductWise({
      distributorCode: distributorId,
      items: finalItems.map((x) => ({
        productId: String(x.productId || "").replace(/^P#/, ""),
        qty: Number(x.qty || 0),
      })),
    });

    const orderItem = {
      pk: `ORDER#${orderId}`,
      sk: "META",
      orderId,
      distributorId,
      distributorName,
      items: finalItems,
      totalAmount,
      totalQty,

      status: "PENDING",

      // 👇 NEW FLAGS
      loadingStarted: false,
      loadingStartedAt: null,

      pendingReason: "",

      createdBy: user.mobile,
      createdRole: user.role,
      createdAt: new Date().toISOString(),

      goalDeducted: true,
      goalDeductedAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: "tickin_orders",
        Item: orderItem,
      })
    );

    // ✅ NEW TIMELINE EVENT (ORDER_CREATED)
    await addTimelineEvent({
      orderId,
      event: "ORDER_CREATED",
      by: user.mobile,
      extra: {
        role: user.role,
        distributorId,
        distributorName,
        totalAmount,
        totalQty,
      },
    });

    await addTimelineEvent({
      orderId,
      event: "ORDER_PLACED_PENDING",
      by: user.mobile,
      extra: {
        role: user.role,
        distributorId,
        distributorName,
        totalAmount,
        totalQty,
      },
    });

    return res.json({
      message: "✅ Order placed (PENDING) + Goal deducted (Product-wise)",
      orderId,
      status: "PENDING",
      distributorName,
      totalAmount,
      totalQty,
      orderCard: {
        distributor: distributorName,
        items: finalItems,
        grandTotal: totalAmount,
        status: "PENDING",
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Pending Orders (Master / Manager)
   - Old + New data safe
========================== */
export const getPendingOrders = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: `
          #st = :pending 
          AND (
            attribute_not_exists(loadingStarted) 
            OR loadingStarted = :ls
          )
        `,
        ExpressionAttributeNames: {
          "#st": "status",
        },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":ls": false,
        },
      })
    );

    return res.json({
      message: "Pending orders (loading not started)",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};



/* ==========================
   ✅ Today Orders (Master only)
========================== */
export const getTodayOrders = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "begins_with(#dt, :today)",
        ExpressionAttributeNames: { "#dt": "createdAt" },
        ExpressionAttributeValues: { ":today": today },
      })
    );

    return res.json({
      message: "Today orders fetched",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Delivery Orders (Master only)
========================== */
export const getDeliveryOrders = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "#dd = :today",
        ExpressionAttributeNames: { "#dd": "deliveryDate" },
        ExpressionAttributeValues: { ":today": today },
      })
    );

    return res.json({
      message: "Delivery orders fetched",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Update Pending Reason (Manager only)
========================== */
export const updatePendingReason = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;
    const user = req.user;

    if (!reason) return res.status(400).json({ message: "Reason required" });

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET pendingReason = :r",
        ExpressionAttributeValues: { ":r": reason },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "REASON_UPDATED",
      by: user.mobile,
      extra: { role: user.role, reason },
    });

    return res.json({
      message: "Pending reason updated successfully",
      orderId,
      reason,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Confirm Order + Slot Booking
========================== */
export const confirmOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;
    const { slot, companyCode } = req.body;

    if (!companyCode) {
      return res.status(400).json({ message: "companyCode required" });
    }

    // ✅ 1) Get order
    const orderRes = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!orderRes.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRes.Item;
    const role = String(user.role || "").trim().toUpperCase();

    // ✅ Only MANAGER can confirm (as you requested)
    if (role !== "MANAGER") {
      return res.status(403).json({ message: "Access denied (MANAGER only)" });
    }

    // ✅ Only PENDING orders can be confirmed
    if (String(order.status || "") !== "PENDING") {
      return res.status(403).json({
        message: `Only PENDING orders can be confirmed. Current status: ${order.status}`,
      });
    }

    // ✅ 2) Confirm Order status => CONFIRMED, slotBooked false initially
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression:
          "SET #st = :c, confirmedBy = :u, confirmedAt = :t, slotBooked = :sb",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":u": user.mobile,
          ":t": new Date().toISOString(),
          ":sb": false,
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "ORDER_CONFIRMED",
      by: user.mobile,
      extra: { role: user.role, note: "Order confirmed" },
    });

    // ✅ 3) Slot booking (if slot data provided)
    let slotBooked = false;
    let slotDetails = null;

    if (slot?.date && slot?.time && slot?.pos) {
      const amount = order.totalAmount || order.grandTotal || 0;

      const booked = await bookSlot({
        companyCode,
        date: slot.date,
        time: slot.time,
        pos: slot.pos,
        userId: user.mobile,
        distributorCode: order.distributorId,
        distributorName: order.distributorName,
        amount,
        orderId,
      });

      slotBooked = true;
      slotDetails = {
        companyCode,
        date: slot.date,
        time: slot.time,
        pos: slot.pos,
        vehicleType: booked?.type || null,
        bookingId: booked?.bookingId || null,
        ...booked,
      };

      // ✅ Store slot + slotBooked in order
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${orderId}`, sk: "META" },
          UpdateExpression: "SET slotBooked = :sb, slot = :slot",
          ExpressionAttributeValues: {
            ":sb": true,
            ":slot": slotDetails,
          },
        })
      );

      // ✅ Create trip record (tickin_trips)
      const tripId = "TRP" + crypto.randomBytes(4).toString("hex").toUpperCase();

      await ddb.send(
        new PutCommand({
          TableName: TRIPS_TABLE,
          Item: {
            pk: `TRIP#${tripId}`,
            sk: "META",
            tripId,
            orderId,
            distributorId: order.distributorId || null,
            distributorName: order.distributorName || null,
            items: order.items || [],
            totalAmount: order.totalAmount || 0,
            totalQty: order.totalQty || 0,
            slot: slotDetails,
            status: "TRIP_CREATED",
            createdAt: new Date().toISOString(),
            createdBy: user.mobile,
            createdRole: user.role,
          },
        })
      );

      // ✅ save tripId in order
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${orderId}`, sk: "META" },
          UpdateExpression: "SET tripId = :tid",
          ExpressionAttributeValues: { ":tid": tripId },
        })
      );
    }

    return res.json({
      ok: true,
      message: "✅ Order confirmed successfully",
      orderId,
      status: "CONFIRMED",
      slotBooked,
      slot: slotDetails,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ UPDATE ORDER ITEMS (PENDING)
   - product-wise goal adjust ✅
========================== */
export const updateOrderItems = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items } = req.body;
    const user = req.user;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items required" });
    }

    const existing = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item)
      return res.status(404).json({ message: "Order not found" });

    const order = existing.Item;

    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can edit" });
    }

    if (order.status !== "PENDING") {
      return res
        .status(403)
        .json({ message: "Only PENDING orders can be edited" });
    }

    let totalAmount = 0;
    let totalQty = 0;

    items.forEach((i) => {
      totalAmount += Number(i.qty) * Number(i.price);
      totalQty += Number(i.qty);
    });

    // ✅ PRODUCT-WISE DIFF (old vs new)
    const oldItems = Array.isArray(order.items) ? order.items : [];
    const newItems = items;

    const oldMap = {};
    for (const it of oldItems) {
      const pid = String(it.productId || "").replace(/^P#/, "");
      oldMap[pid] = (oldMap[pid] || 0) + Number(it.qty || 0);
    }

    const newMap = {};
    for (const it of newItems) {
      const pid = String(it.productId || "").replace(/^P#/, "");
      newMap[pid] = (newMap[pid] || 0) + Number(it.qty || 0);
    }

    const toDeduct = [];
    const toAddBack = [];

    const allPids = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
    for (const pid of allPids) {
      const oldQ = Number(oldMap[pid] || 0);
      const newQ = Number(newMap[pid] || 0);
      const diff = newQ - oldQ;

      if (diff > 0) toDeduct.push({ productId: pid, qty: diff });
      if (diff < 0) toAddBack.push({ productId: pid, qty: Math.abs(diff) });
    }

    // ✅ Deduct increases
    if (toDeduct.length > 0) {
      await deductDistributorMonthlyGoalProductWise({
        distributorCode: order.distributorId,
        items: toDeduct,
      });
    }

    // ✅ Addback decreases
    if (toAddBack.length > 0) {
      await addBackDistributorMonthlyGoalProductWise({
        distributorCode: order.distributorId,
        items: toAddBack,
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression:
          "SET items = :it, totalAmount = :ta, totalQty = :tq, updatedAt = :u",
        ExpressionAttributeValues: {
          ":it": items,
          ":ta": totalAmount,
          ":tq": totalQty,
          ":u": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "ORDER_ITEMS_UPDATED",
      by: user.mobile,
      extra: {
        role: user.role,
        totalAmount,
        totalQty,
        toDeduct,
        toAddBack,
      },
    });

    return res.json({
      message: "✅ Order updated successfully (goal adjusted product-wise)",
      orderId,
      status: "PENDING",
      totalAmount,
      totalQty,
      items,
      goalAdjust: { toDeduct, toAddBack },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Delete Order (Cancel) + product-wise goal restore
========================== */
export const deleteOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    const existing = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item)
      return res.status(404).json({ message: "Order not found" });

    const order = existing.Item;
    const role = String(user.role || "").toUpperCase();

// ✅ Manager/Master can delete any order
const isAdmin = role === "MANAGER" || role === "MASTER";

if (!isAdmin && order.createdBy !== user.mobile) {
  return res.status(403).json({ message: "Only creator or Manager can delete" });
}

// ✅ Creator can delete only pending
if (!isAdmin && order.status !== "PENDING") {
  return res.status(403).json({ message: "Only PENDING orders can be deleted by creator" });
}
    // ✅ Restore goal fully (product-wise)
    const backItems = (order.items || []).map((x) => ({
      productId: String(x.productId || "").replace(/^P#/, ""),
      qty: Number(x.qty || 0),
    }));

    await addBackDistributorMonthlyGoalProductWise({
      distributorCode: order.distributorId,
      items: backItems,
    });

    // ✅ Mark cancelled
    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET #st = :c, cancelledAt = :t, cancelledBy = :u",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CANCELLED",
          ":t": new Date().toISOString(),
          ":u": user.mobile,
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "ORDER_CANCELLED",
      by: user.mobile,
      extra: { role: user.role, note: "Order cancelled and goal restored product-wise" },
    });

    return res.json({
      message: "✅ Order cancelled + goal restored (product-wise)",
      orderId,
      status: "CANCELLED",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/**
 * ✅ Sales officer: fetch all orders of distributors mapped to his location
 * Returns DRAFT + PENDING + CONFIRMED
 */
export const getOrdersForSalesman = async ({ distributorCodes, status }) => {
  if (!Array.isArray(distributorCodes) || distributorCodes.length === 0) {
    return { count: 0, distributorCodes: [], orders: [] };
  }

  const expVals = {};
  const inKeys = distributorCodes.map((_, i) => `:d${i}`);
  distributorCodes.forEach((code, i) => {
    expVals[`:d${i}`] = String(code).trim();
  });

  let filter = `distributorId IN (${inKeys.join(",")})`;

  // ✅ only confirmed orders
  if (status) {
    filter += " AND #s = :st";
    expVals[":st"] = String(status).toUpperCase();
  }

  const res = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: filter,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: expVals,
    })
  );

  return {
    count: res.Items?.length || 0,
    distributorCodes,
    orders: res.Items || [],
  };
};
/**
 * ✅ Manager/Master: fetch all orders (optional status filter)
 */
export const getAllOrders = async ({ status }) => {
  const params = {
    TableName: ORDERS_TABLE,
  };

  if (status) {
    params.FilterExpression = "#s = :st";
    params.ExpressionAttributeNames = { "#s": "status" };
    params.ExpressionAttributeValues = { ":st": String(status).toUpperCase() };
  }

  const res = await ddb.send(new ScanCommand(params));

  return {
    count: res.Items?.length || 0,
    status: status ? String(status).toUpperCase() : "ALL",
    orders: res.Items || [],
  };
};

export const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ message: "orderId required" });
    }

    const cleanId = String(orderId).startsWith("ORDER#")
      ? String(orderId).replace("ORDER#", "")
      : String(orderId);

    const result = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${cleanId}`, sk: "META" },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    return res.json({
      ok: true,
      order: result.Item,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};
