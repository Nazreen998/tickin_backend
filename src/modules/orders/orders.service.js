import {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { bookSlot } from "../slot/slot.service.js";
import { buildOrderStopsFromDistributorId } from "../../services/orderStops.helper.js";
import {
  deductDistributorMonthlyGoalProductWise,
  addBackDistributorMonthlyGoalProductWise,
} from "../../services/goals.service.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const TRIPS_TABLE = process.env.TRIPS_TABLE || "tickin_trips";
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE || "tickin_slot_bookings";

export const getSlotConfirmedOrders = async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        ok: false,
        message: "date is required (YYYY-MM-DD)",
      });
    }

    const pk = `COMPANY#VAGR_IT#DATE#${date}`;

    const bookingsRes = await ddb.send(
      new ScanCommand({
        TableName: BOOKINGS_TABLE,
        FilterExpression:
          "#pk = :pk AND (attribute_not_exists(isActive) OR isActive = :t)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: {
          ":pk": pk,
          ":t": true,
        },
      })
    );

    const bookings = bookingsRes.Items || [];

    if (bookings.length === 0) {
      return res.json({ ok: true, count: 0, date, orders: [] });
    }

    const grouped = {};

    /* -------------------------------------------------- */
    /* 1️⃣ GROUP BOOKINGS */
    /* -------------------------------------------------- */

    for (const b of bookings) {
      const oid = String(b.orderId || "").trim();
      if (!oid) continue;

      if (String(b.status || "").toUpperCase() === "CANCELLED") continue;
      if (b.isActive === false) continue;
      if (!b.slotTime) continue;

      const masterId =
        b.mergedIntoOrderId &&
        String(b.mergedIntoOrderId).startsWith("ORD_FULL_")
          ? b.mergedIntoOrderId
          : null;

      const flowKey = masterId || b.mergeKey || oid;

      if (!grouped[flowKey]) {
        grouped[flowKey] = {
          flowKey,
          date,
          slotTime: b.slotTime,
          pos: b.slotPos || b.pos || null,
          vehicleType: masterId ? "FULL" : b.vehicleType || "-",
          orderIds: [],
          distributors: [],
          distributorOrder: [], // 👈 preserve original order
          totalQty: 0,
          grandAmount: 0,
        };
      }

      // ----------------------------
      // ✅ FULL Booking Record
      // ----------------------------
      if (oid.startsWith("ORD_FULL_")) {

        const rawName = String(b.distributorName || "").trim();

        grouped[flowKey].distributorOrder = rawName
          .split("+")
          .map(x => x.trim())
          .filter(Boolean);

        continue; // stop FULL booking processing
      }
      
      // ----------------------------
      // ✅ CHILD Booking Record
      // ----------------------------

      // push child orderId
      if (!grouped[flowKey].orderIds.includes(oid)) {
        grouped[flowKey].orderIds.push(oid);
      }

      // ✅ SINGLE ORDER fallback
      if (!grouped[flowKey].distributorOrder.length) {
        const rawName = String(b.distributorName || "").trim();
        grouped[flowKey].distributorOrder = [rawName];
      }

      // sum amount
      grouped[flowKey].grandAmount += Number(b.amount || 0);
    }

    /* -------------------------------------------------- */
    /* 2️⃣ FETCH CHILD ORDER QTY + STATUS */
    /* -------------------------------------------------- */

    const PRIORITY = [
      "DELIVERY_COMPLETED",
      "DELIVERED",
      "OUT_FOR_DELIVERY",
      "DRIVER_ASSIGNED",
      "LOADING_COMPLETED",
      "LOADING_STARTED",
      "VEHICLE_SELECTED",
      "SLOT_BOOKING_COMPLETED",
      "SLOT_BOOKED",
      "CONFIRMED",
    ];

    const finalOrders = [];

    for (const g of Object.values(grouped)) {
      let status = "CONFIRMED";
      let totalQty = 0;

      for (const oid of g.orderIds) {
        if (oid.startsWith("ORD_FULL_")) continue;

        const child = await ddb.send(
          new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { pk: `ORDER#${oid}`, sk: "META" },
          })
        );

        if (!child.Item) continue;

        totalQty += Number(child.Item.totalQty || 0);

        const st = String(child.Item.status || "").toUpperCase();
        if (PRIORITY.indexOf(st) < PRIORITY.indexOf(status)) {
          status = st;
        }
      }

      /* -------------------------------------------------- */
      /* 3️⃣ BUILD CLEAN DISTRIBUTOR LIST */
      /* -------------------------------------------------- */

      const cleanDistributors = g.distributorOrder.map((name, i) => ({
        distributorName: name,
        position: `D${i + 1}`,
      }));

      const distributorString = cleanDistributors
        .map((d, i) => `D${i + 1}: ${d.distributorName}`)
        .join(" | ");

      finalOrders.push({
        flowKey: g.flowKey,
        date: g.date,
        slotTime: g.slotTime,
        pos: g.pos,
        vehicleType: g.vehicleType,
        orderIds: g.orderIds,
        distributors: cleanDistributors,
        distributorName: distributorString,
        totalQty,
        grandAmount: Number(g.grandAmount.toFixed(2)),
        status,
        orderId: g.flowKey,
      });
    }

    return res.json({
      ok: true,
      count: finalOrders.length,
      date,
      orders: finalOrders,
    });
  } catch (err) {
    console.error("getSlotConfirmedOrders error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export async function forceResetOrderSlotMeta(orderId) {
  if (!orderId) throw new Error("orderId required");

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression:
        "SET slotBooked = :sb, updatedAt = :u " +
        "REMOVE slotId, slotDate, slotTime, slotVehicleType, slotPos, mergeKey, locationId, mergedIntoOrderId, tripStatus",
      ExpressionAttributeValues: {
        ":sb": false,
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "FORCE RESET DONE", orderId };
}
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
        TableName: ORDERS_TABLE,
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
   return res.status(403).json({
  ok: false,
  message: "Order already confirmed",
});
}
    // ✅ CHANGE HERE
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "SET #st = :c, confirmedAt = :t, confirmedBy = :u, slotBooked = :sb",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":t": new Date().toISOString(),
          ":u": user.mobile,
          ":sb": false,
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "ORDER_CONFIRMED",
      by: user.mobile,
      extra: { role: user.role, note: "Draft order confirmed directly" },
    });

    return res.json({
      ok: true,
      message: "✅ Draft Order confirmed successfully",
      orderId,
      status: "CONFIRMED",
      totalAmount: order.totalAmount,
      distributorName: order.distributorName,
      slotBooked: false,
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
        role === "SALES_OFFICER_VNR" ||
        role === "SALES OFFICER VNR" ||
        role === "SALESMAN"
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

    // ✅ GOAL DEDUCT
    await deductDistributorMonthlyGoalProductWise({
      distributorCode: distributorId,
      items: finalItems.map((x) => ({
        productId: String(x.productId || "").replace(/^P#/, ""),
        qty: Number(x.qty || 0),
      })),
    });

    // ✅ 🔥 CHANGE HERE: Default status should be CONFIRMED for salesman/sales officer
    const finalStatus =
      role === "SALESMAN" || role.includes("SALES")
        ? "CONFIRMED"
        : "PENDING";
const stops = await buildOrderStopsFromDistributorId({
  distributorId,
  distributorName: null, // நீங்க orderItem-ல distributorName store பண்ணல, so null ok
  items: finalItems,
});
const createdAt = new Date().toISOString();

    const orderItem = {
      pk: `ORDER#${orderId}`,
      sk: "META",
      orderId,
      distributorId,
      distributorName,
      items: finalItems,
      totalAmount,
      totalQty,
     status: finalStatus,
      distributors: stops,
      currentDistributorIndex: 0,

      // ✅ NEW FLAGS (keep safe)
      loadingStarted: false,
      loadingStartedAt: null,

      pendingReason: "",

      createdBy: user.mobile,
      createdRole: user.role,
      createdAt,

       // ✅ GSI FIELDS ADD HERE 🔥
      gsi1pk: "ORDER_META",
      gsi1sk: createdAt,

      confirmedAt: finalStatus === "CONFIRMED" ? new Date().toISOString() : null,
      confirmedBy: finalStatus === "CONFIRMED" ? user.mobile : null,

      goalDeducted: true,
      goalDeductedAt: new Date().toISOString(),

      slotBooked: false, // ✅ VERY IMPORTANT
    };

    await ddb.send(
      new PutCommand({
        TableName: "tickin_orders",
        Item: orderItem,
      })
    );

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
        status: finalStatus,
      },
    });

    await addTimelineEvent({
      orderId,
      event: finalStatus === "CONFIRMED" ? "ORDER_CONFIRMED" : "ORDER_PLACED_PENDING",
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
      ok: true,
      message:
        finalStatus === "CONFIRMED"
          ? "✅ Order created & confirmed"
          : "✅ Order placed (PENDING)",

      orderId,
      status: finalStatus,
      distributorName,
      totalAmount,
      totalQty,

      slotBooked: false,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

/* ==========================
   ✅ Pending Orders (Manager / Master)
   - CONFIRMED
   - Loading NOT started
========================== */
export const getPendingOrders = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: `
          #st = :confirmed
          AND (
            attribute_not_exists(loadingStartedAt)
            OR loadingStartedAt = :null
          )
        `,
        ExpressionAttributeNames: {
          "#st": "status",
        },
        ExpressionAttributeValues: {
          ":confirmed": "CONFIRMED",
          ":null": null,
        },
      })
    );

    return res.json({
      ok: true,
      message: "Pending orders (before loading)",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
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
async function buildDistributorFromMaster(order) {
  if (!order?.distributorId) return [];

  const master = await getDistributorFromMaster(order.distributorId);
  if (!master || !master.lat || !master.lng) return [];

  return [
    {
      distributorCode: master.distributorCode,
      distributorName: master.distributorName || order.distributorName,
      lat: master.lat,
      lng: master.lng,
      mapUrl: master.mapUrl || null,
      items: order.items || [],
      reachedAt: null,
      unloadStartAt: null,
      unloadEndAt: null,
    },
  ];
}

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
    const isAdmin = ["MASTER", "MANAGER", "DISTRIBUTOR", "SALESMAN", "SALES OFFICER","SALES_OFFICER_VNR","SALES OFFICER VNR"].includes(role);
    // ✅ 2) Confirm Order status => CONFIRMED, slotBooked false initially
    await ddb.send(
  new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression: `
      SET #st = :c,
          confirmedBy = :u,
          confirmedAt = :t,
          slotBooked = :sb,
          updatedAt = :t
      REMOVE cancelledAt, cancelledBy,
             slotId, slotDate, slotTime, slotPos, slotVehicleType,
             slot
    `,
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
  byUserName: user?.name || user?.userName || null,
  role: user?.role || "MANAGER",
  data: { note: "Order confirmed" },
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

const slotIdValue =
  booked?.bookingId ||
  `${companyCode}#${slot.date}#${slot.time}#${booked?.type || "FULL"}#${slot.pos}`;
    
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
      const now = new Date().toISOString();

await ddb.send(
  new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression: `
      SET slotBooked = :sb,
          slot = :slot,
          slotDate = :sd,
          slotTime = :st,
          slotPos = :sp,
          slotVehicleType = :svt,
          slotId = :sid,
          updatedAt = :u,
          slotBookedAt = :u
    `,
    ExpressionAttributeValues: {
      ":sb": true,
      ":slot": slotDetails,
      ":sd": slot.date,
      ":st": slot.time,
      ":sp": slot.pos,
      ":svt": slotDetails?.vehicleType || booked?.type || null,
      ":sid": slotIdValue,
      ":u": now,
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
    const now = new Date().toISOString();

await ddb.send(
  new UpdateCommand({
    TableName: "tickin_orders",
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression: `
      SET #st = :c,
          cancelledAt = :t,
          cancelledBy = :u,
          slotBooked = :sb,
          updatedAt = :t
      REMOVE slot, slotId, slotDate, slotTime, slotPos, slotVehicleType
    `,
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: {
      ":c": "CANCELLED",
      ":t": now,
      ":u": user.mobile,
      ":sb": false,
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
export const cancelOrderSlot = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    const existing = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item) return res.status(404).json({ message: "Order not found" });

    const order = existing.Item;

    // ✅ allow only MANAGER/MASTER (optional)
    const role = String(user.role || "").toUpperCase();
    const isAdmin = role === "MANAGER" || role === "MASTER";
    if (!isAdmin) return res.status(403).json({ message: "Access denied" });

    // ✅ If no slot booked, nothing to cancel
    if (!order.slotBooked) {
      return res.json({ ok: true, message: "No slot booked already", orderId });
    }

    const now = new Date().toISOString();

    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: `
          SET slotBooked = :sb,
              updatedAt = :u
          REMOVE slot, slotId, slotDate, slotTime, slotPos, slotVehicleType
        `,
        ExpressionAttributeValues: {
          ":sb": false,
          ":u": now,
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "SLOT_CANCELLED",
      by: user.mobile,
      extra: { role: user.role, note: "Slot cancelled only (order kept)" },
    });

    return res.json({
      ok: true,
      message: "✅ Slot cancelled (order kept CONFIRMED)",
      orderId,
      slotBooked: false,
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
export const getOrdersForSalesman = async ({
  distributorCodes,
  status,
  date,
}) => {
  if (!Array.isArray(distributorCodes) || distributorCodes.length === 0) {
    return { count: 0, distributorCodes: [], orders: [] };
  }

  const expVals = {};
  const expNames = {};

  const inKeys = distributorCodes.map((_, i) => `:d${i}`);
  distributorCodes.forEach((code, i) => {
    expVals[`:d${i}`] = String(code).trim();
  });

  let filter = `distributorId IN (${inKeys.join(",")})`;

  if (status) {
    filter += " AND #s = :st";
    expNames["#s"] = "status";
    expVals[":st"] = String(status).toUpperCase();
  }

  if (date) {
    const start = `${date}T00:00:00.000Z`;
    const end = `${date}T23:59:59.999Z`;

    filter += " AND #ca BETWEEN :start AND :end";
    expNames["#ca"] = "createdAt";
    expVals[":start"] = start;
    expVals[":end"] = end;
  }

  const res = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: filter,
      ExpressionAttributeNames:
        Object.keys(expNames).length > 0 ? expNames : undefined,
      ExpressionAttributeValues: expVals,
    })
  );

  let orders = res.Items || [];

  // ❌ Remove cancelled always
  orders = orders.filter(
    (o) => String(o.status || "").toUpperCase() !== "CANCELLED"
  );

  // ❌ Hide merged FULL orders only
  orders = orders.filter((o) => {
    if (o.isMerged === true) return false;
    if (Array.isArray(o.mergedOrderIds) && o.mergedOrderIds.length > 0)
      return false;
    return true;
  });

  return {
    count: orders.length,
    distributorCodes,
    orders,
  };
};

/**
 * ✅ Manager/Master: Fetch all orders (FAST)
 * Filters:
 * - date (yyyy-MM-dd)
 * - status (optional)
 *
 * Uses GSI_ORDER_META_CREATEDAT
 */
export const getAllOrders = async ({ date, status }) => {
  if (!date) {
    throw new Error("date is required for querying orders");
  }

  const start = `${date}T00:00:00.000Z`;
  const end = `${date}T23:59:59.999Z`;

  // ✅ Query DynamoDB using GSI
  const res = await ddb.send(
    new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: "GSI_ORDER_META_CREATEDAT",

      KeyConditionExpression:
        "gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end",

      ExpressionAttributeValues: {
        ":pk": "ORDER_META",
        ":start": start,
        ":end": end,
      },

      ScanIndexForward: false, // latest orders first
    })
  );

  let orders = res.Items || [];

  orders = orders.filter((o) => {
  const st = String(o.status || "").trim().toUpperCase();

  // ❌ Remove cancelled always
  if (st === "CANCELLED") return false;

  // ❌ Remove only merged FULL orders
  if (o.isMerged === true) return false;

  if (Array.isArray(o.mergedOrderIds) && o.mergedOrderIds.length > 0)
    return false;

  if (Array.isArray(o.childOrderIds) && o.childOrderIds.length > 0)
    return false;

  return true;
});


  // ✅ Optional status filter
  if (status) {
    const st = String(status).trim().toUpperCase();
    orders = orders.filter((o) => String(o.status).toUpperCase() === st);
  }

  return {
    count: orders.length,
    date,
    status: status ? status.toUpperCase() : "ALL",
    orders,
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
export const getOrdersByMergeKey = async (req, res) => {
  try {
    const { mergeKey } = req.params;

    const scanRes = await ddb.send(
      new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: "mergeKey = :mk",
        ExpressionAttributeValues: { ":mk": mergeKey },
      })
    );

    return res.json({
      ok: true,
      mergeKey,
      count: scanRes.Items?.length || 0,
      orders: scanRes.Items || [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
export async function getAssignedOrdersByDriver(driverId) {
  if (!driverId) return [];

  // 1️⃣ Get orderIds from GSI
  const q = await ddb.send(
    new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: "GSI_DRIVER_ASSIGNED",
      KeyConditionExpression: "driverId = :d",
      ExpressionAttributeValues: {
        ":d": driverId,
      },
      ScanIndexForward: false,
    })
  );

  const ids = (q.Items || [])
    .map(o => o.orderId)
    .filter(Boolean);

  if (ids.length === 0) return [];

  // 2️⃣ Fetch FULL META for each order
  const results = [];

  for (const oid of ids) {
    const g = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${oid}`, sk: "META" },
      })
    );

    if (!g.Item) continue;

    const o = g.Item;

    // ❌ hide merged child orders
    if (o.mergedIntoOrderId && !String(o.orderId).startsWith("ORD_FULL_")) {
      continue;
    }

    results.push({
      ...o,
      totalAmount: Number(o.totalAmount || 0),
      totalQty: Number(o.totalQty || 0),
      distributorDisplay: Array.isArray(o.distributors)
        ? o.distributors.map(d => d.distributorName).join(" + ")
        : o.distributorName || "-",
    });
  }

  return results;
}
