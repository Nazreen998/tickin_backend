import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";
const TABLE_SLOT_TIMELINE =
  process.env.TABLE_SLOT_TIMELINE || "tickin_timeline_events";

// ✅ Driver table
const TABLE_USERS = process.env.USERS_TABLE || "tickin_users";

/* ✅ Resolve FULL OrderId if HALF merged */
async function resolveTargetOrderId(orderId) {
  if (!orderId) return null;

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  if (!res.Item) return orderId;

  if (res.Item.mergedIntoOrderId) return String(res.Item.mergedIntoOrderId);

  return orderId;
}

/* ✅ Allocation check (own OR allocated) */
function isAllocatedToUser(meta, user) {
  const uid = String(user.userId || user.id || user.mobile || "");

  const direct = [
    meta.salesOfficerId,
    meta.allocatedTo,
    meta.assignedTo,
    meta.assignedUserId,
    meta.distributorId,
    meta.userId,
    meta.createdBy,
  ]
    .filter(Boolean)
    .map(String);

  if (direct.includes(uid)) return true;

  const arr =
    meta.allocatedOrderIds ||
    meta.assignedOrderIds ||
    meta.allocatedOrders ||
    meta.orders ||
    [];

  if (Array.isArray(arr) && arr.map(String).includes(String(meta.orderId || "")))
    return true;

  return false;
}

/* ✅ Get Driver Name from tickin_users */
async function getDriverName(driverId) {
  if (!driverId) return null;

  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { pk: `USER#${driverId}`, sk: "META" },
      })
    );

    const d = res.Item;
    if (!d) return null;

    return d.name || d.userName || d.fullName || d.mobile || null;
  } catch (e) {
    return null;
  }
}

/* ✅ Build Neat Timeline (YOUR FINAL FLOW) */
function buildNeatTimeline(events = []) {
  const STEPS = [
    { key: "ORDER_CREATED", label: "Order Created" },
    { key: "ORDER_CONFIRMED", label: "Order Confirmed" },
    { key: "SLOT_BOOKING", label: "Slot Booking" },
    { key: "SLOT_BOOKING_COMPLETED", label: "Slot Booking Completed" },
    { key: "VEHICLE_SELECTED", label: "Vehicle Selected" },
    { key: "LOADING_START", label: "Loading Start" },
    { key: "LOADING_COMPLETED", label: "Loading Completed" },
    { key: "DRIVER_ASSIGNED", label: "Driver Assigned" },
    { key: "DRIVE_STARTED", label: "Drive Started" },
    { key: "REACHED_D1", label: "Reached D1" },
    { key: "UNLOADING_START_D1", label: "Unloading Start D1" },
    { key: "UNLOADING_END_D1", label: "Unloading End D1" },
    { key: "REACHED_D2", label: "Reached D2" },
    { key: "UNLOADING_START_D2", label: "Unloading Start D2" },
    { key: "UNLOADING_END_D2", label: "Unloading End D2" },
    { key: "WAREHOUSE_REACHED", label: "Warehouse Reached" },
    { key: "DELIVERY_COMPLETED", label: "Delivery Completed" },
  ];

  // ✅ keep latest event per key
  const map = {};
  for (const e of events) {
    if (!e?.event) continue;
    const key = String(e.event).toUpperCase();

    if (!map[key]) {
      map[key] = e;
    } else {
      const oldT = new Date(map[key].createdAt || map[key].timestamp || 0);
      const newT = new Date(e.createdAt || e.timestamp || 0);
      if (newT > oldT) map[key] = e;
    }
  }

  // ✅ find last done step
  let lastDoneIdx = -1;
  STEPS.forEach((s, idx) => {
    if (map[s.key]) lastDoneIdx = idx;
  });

  return STEPS.map((s, idx) => {
    const ev = map[s.key] || null;

    let status = "UPCOMING";
    if (ev) status = "DONE";
    else if (idx === lastDoneIdx + 1) status = "CURRENT";

    return {
      step: idx + 1,
      key: s.key,
      title: s.label,
      status,
      time: ev?.displayTime || ev?.createdAt || ev?.timestamp || null,
      data: ev?.data || null,
      raw: ev,
    };
  });
}

/* ✅ Build Meta for UI */
async function buildMeta(meta) {
  const driverId =
    meta.driverId || meta.driverUserId || meta.driverMobile || null;

  const driverName = await getDriverName(driverId);

  return {
    distributorName:
      meta.distributorName ||
      meta.distributor ||
      meta.agencyName ||
      meta.customerName ||
      meta.companyName ||
      null,

    vehicleNo:
      meta.vehicleNo ||
      meta.vehicleNumber ||
      meta.vehicle ||
      meta.vehicleId ||
      null,

    driverId,
    driverName: driverName || meta.driverName || meta.driverMobile || null,

    status: meta.status || null,
    slotId: meta.slotId || meta.slotPk || null,
  };
}

/* ✅ GET Order Timeline (RAW + NEAT + META) */
export async function getOrderTimeline(req, res) {
  try {
    const { orderId } = req.params;
    if (!orderId)
      return res.status(400).json({ ok: false, message: "orderId required" });

    const targetOrderId = await resolveTargetOrderId(orderId);

    // ✅ fetch order meta
    const orderMetaRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${targetOrderId}`, sk: "META" },
      })
    );

    const meta = orderMetaRes.Item;
    if (!meta)
      return res.status(404).json({ ok: false, message: "Order not found" });

    const user = req.user || {};
    const role = String(user.role || "").toUpperCase();

    // ✅ MASTER / MANAGER can access all
    if (role !== "MASTER" && role !== "MANAGER") {
      // ✅ Distributor / Sales => own OR allocated
      if (
        role === "DISTRIBUTOR" ||
        role === "SALESMAN" ||
        role === "SALES OFFICER"
      ) {
        const metaUserId = String(meta.userId || meta.createdBy || "");
        const loggedUserId = String(user.userId || user.id || user.mobile || "");

        const isOwn = metaUserId === loggedUserId;
        const isAllocated = isAllocatedToUser(meta, user);

        if (!isOwn && !isAllocated) {
          return res.status(403).json({ ok: false, message: "Not allowed" });
        }
      }

      // ✅ Driver => assigned orders only
      if (role === "DRIVER") {
        const loggedDriverId = String(user.userId || user.id || user.mobile || "");
        const orderDriverId = String(meta.driverId || "");

        if (orderDriverId && orderDriverId !== loggedDriverId) {
          return res.status(403).json({ ok: false, message: "Not allowed" });
        }
      }
    }

    // ✅ query timeline
    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ORDER#${targetOrderId}` },
        ScanIndexForward: true,
      })
    );

    const rawTimeline = out.Items || [];
    const neatTimeline = buildNeatTimeline(rawTimeline);
    const uiMeta = await buildMeta(meta);

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      meta: uiMeta,
      timeline: rawTimeline,
      neatTimeline,
    });
  } catch (e) {
    console.error("getOrderTimeline error:", e);
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

/* ✅ GET Slot Timeline */
export async function getSlotTimeline(req, res) {
  try {
    const { slotId } = req.params;
    if (!slotId)
      return res.status(400).json({ ok: false, message: "slotId required" });

    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_SLOT_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `SLOT#${slotId}` },
        ScanIndexForward: true,
      })
    );

    const rawTimeline = out.Items || [];
    const neatTimeline = buildNeatTimeline(rawTimeline);

    return res.json({ ok: true, slotId, timeline: rawTimeline, neatTimeline });
  } catch (e) {
    console.error("getSlotTimeline error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/* ✅ ONLY neat response (WITH META) */
export async function getOrderTimelineNeat(req, res) {
  try {
    const { orderId } = req.params;
    if (!orderId)
      return res.status(400).json({ ok: false, message: "orderId required" });

    const targetOrderId = await resolveTargetOrderId(orderId);

    const orderMetaRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${targetOrderId}`, sk: "META" },
      })
    );
    const meta = orderMetaRes.Item || {};

    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ORDER#${targetOrderId}` },
        ScanIndexForward: true,
      })
    );

    const rawTimeline = out.Items || [];
    const neatTimeline = buildNeatTimeline(rawTimeline);
    const uiMeta = await buildMeta(meta);

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      meta: uiMeta,
      neatTimeline,
    });
  } catch (e) {
    console.error("getOrderTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/* ✅ ONLY slot neat response */
export async function getSlotTimelineNeat(req, res) {
  try {
    const { slotId } = req.params;
    if (!slotId)
      return res.status(400).json({ ok: false, message: "slotId required" });

    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_SLOT_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `SLOT#${slotId}` },
        ScanIndexForward: true,
      })
    );

    const rawTimeline = out.Items || [];
    const neatTimeline = buildNeatTimeline(rawTimeline);

    return res.json({ ok: true, slotId, neatTimeline });
  } catch (e) {
    console.error("getSlotTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}