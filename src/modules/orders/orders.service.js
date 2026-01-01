import {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

import { ddb } from "../../config/dynamo.js";
import { v4 as uuidv4 } from "uuid";
import { pairingMap } from "../../appInit.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { bookSlot } from "../slot/slot.service.js";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
import { deductDistributorMonthlyGoal, addBackDistributorMonthlyGoal } from "../../services/goals.service.js";

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
   ✅ Create Order (DRAFT)
========================== */
export const createOrder = async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || "").toUpperCase();
    const { distributorId, distributorName, items } = req.body;

    if (!(role === "SALES OFFICER" || role === "SALES_OFFICER" || role === "MANAGER")) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!distributorId || !distributorName) {
      return res.status(400).json({ message: "DistributorId + DistributorName required" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items required" });
    }

    let finalItems = [];
    let totalAmount = 0;
    let totalQty = 0;

    for (const it of items) {
      const pid = it.productId.startsWith("P#") ? it.productId : `P#${it.productId}`;

      const prodRes = await ddb.send(
        new GetCommand({
          TableName: "tickin_products",
          Key: { pk: "PRODUCT", sk: pid },
        })
      );

      if (!prodRes.Item) {
        return res.status(400).json({ message: `Product not found: ${it.productId}` });
      }

      const prod = prodRes.Item;
      const qty = Number(it.qty || 0);
      if (qty <= 0) return res.status(400).json({ message: "Qty must be > 0" });

      const itemTotal = qty * Number(prod.price);

      finalItems.push({
        productId: prod.productId,
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

    // ✅ Deduct goal immediately (order podum pothey)
    await deductDistributorMonthlyGoal({
      distributorCode: distributorId,
      qty: totalQty,
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

      // ✅ No DRAFT, direct PENDING
      status: "PENDING",
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
      extra: { role: user.role, distributorId, distributorName, totalAmount, totalQty },
    });

    return res.json({
      message: "✅ Order placed (PENDING) + Goal deducted",
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
========================== */
export const getPendingOrders = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "#st = :pending",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":pending": "PENDING" },
      })
    );

    return res.json({
      message: "Pending orders fetched",
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
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!orderRes.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRes.Item;
    const role = (user.role || "").toUpperCase();

    // ✅ Sales Officer + Manager can confirm
    if (
      !(
        role === "SALES OFFICER" ||
        role === "SALES_OFFICER" ||
        role === "MANAGER"
      )
    ) {
      return res.status(403).json({ message: "Access denied" });
    }

    // ✅ Only PENDING orders can be confirmed
    if (order.status !== "PENDING") {
      return res.status(403).json({
        message: `Only PENDING orders can be confirmed. Current status: ${order.status}`,
      });
    }

    // ✅ 2) Confirm Order (NO GOAL DEDUCTION HERE)
    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET #st = :c, confirmedBy = :u, confirmedAt = :t",
        ExpressionAttributeNames: {
          "#st": "status",
        },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":u": user.mobile,
          ":t": new Date().toISOString(),
        },
      })
    );

    // ✅ timeline event
    await addTimelineEvent({
      orderId,
      event: "ORDER_CONFIRMED",
      by: user.mobile,
      extra: { role: user.role, note: "Order confirmed" },
    });

    /* ===================================================
       ✅ SLOT BOOKING (Manager OR Sales can do)
       - distributorCode should be order.distributorId ✅
    =================================================== */

    let slotBooked = false;

    if (slot?.date && slot?.time && slot?.vehicleType && slot?.pos) {
      await bookSlot({
        companyCode,
        date: slot.date,
        time: slot.time,
        vehicleType: slot.vehicleType,
        pos: slot.pos,
        userId: user.mobile,

        // ✅ slot booking should be for ORDER distributor
        distributorCode: order.distributorId,

        amount: order.totalAmount || order.grandTotal || 0,
        orderId,

        requesterRole: role,
        requesterDistributorCode:
          user.distributorCode || user.distributorId || null,
      });

      slotBooked = true;
    }

    return res.json({
      message: "✅ Order confirmed successfully",
      orderId,
      status: "CONFIRMED",
      slotBooked,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ UPDATE ORDER ITEMS (THIS WAS MISSING ✅)
   Salesman can edit only DRAFT
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

    if (!existing.Item) return res.status(404).json({ message: "Order not found" });

    const order = existing.Item;

    // ✅ Only creator can edit
    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can edit" });
    }

    // ✅ Only PENDING can be edited
    if (order.status !== "PENDING") {
      return res.status(403).json({ message: "Only PENDING orders can be edited" });
    }

    let totalAmount = 0;
    let totalQty = 0;

    items.forEach((i) => {
      totalAmount += Number(i.qty) * Number(i.price);
      totalQty += Number(i.qty);
    });

    const oldQty = Number(order.totalQty || 0);
    const diff = totalQty - oldQty;

    // ✅ if qty increased → deduct extra
    if (diff > 0) {
      await deductDistributorMonthlyGoal({
        distributorCode: order.distributorId,
        qty: diff,
      });
    }

    // ✅ if qty reduced → add back
    if (diff < 0) {
      await addBackDistributorMonthlyGoal({
        distributorCode: order.distributorId,
        qty: Math.abs(diff),
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET items = :it, totalAmount = :ta, totalQty = :tq, updatedAt = :u",
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
      extra: { role: user.role, totalAmount, totalQty, diff },
    });

    return res.json({
      message: "✅ Order updated successfully (goal adjusted)",
      orderId,
      status: "PENDING",
      totalAmount,
      totalQty,
      items,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};
/**Delete Order */
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

    if (!existing.Item) return res.status(404).json({ message: "Order not found" });

    const order = existing.Item;

    // ✅ Only creator can delete
    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can delete" });
    }

    // ✅ Only PENDING can be deleted
    if (order.status !== "PENDING") {
      return res.status(403).json({ message: "Only PENDING orders can be deleted" });
    }

    // ✅ Restore goal fully
    await addBackDistributorMonthlyGoal({
      distributorCode: order.distributorId,
      qty: Number(order.totalQty || 0),
    });

    // ✅ Mark order cancelled (don’t delete DB record)
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
      extra: { role: user.role, note: "Order cancelled and goal restored" },
    });

    return res.json({
      message: "✅ Order cancelled + goal restored",
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
export const getOrdersForSalesman = async ({ location }) => {
  const distributors = pairingMap?.[location] || [];
  const distributorCodes = distributors.map((d) => String(d.distributorId).trim());

  if (distributorCodes.length === 0) {
    return { distributorCount: 0, distributorCodes: [], orders: [] };
  }

  // ⚠️ Scan is OK for now, later GSI optimization recommended
  const res = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression:
        "distributorId IN (" +
        distributorCodes.map((_, i) => `:d${i}`).join(",") +
        ")",
      ExpressionAttributeValues: distributorCodes.reduce((acc, code, i) => {
        acc[`:d${i}`] = code;
        return acc;
      }, {}),
    })
  );

  return {
    distributorCount: distributorCodes.length,
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

  // optional filter by status
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

    // ✅ Support both "ORDxxxx" and "ORDER#ORDxxxx"
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
