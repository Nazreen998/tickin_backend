import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = "Asia/Kolkata";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";
const TABLE_SLOT_TIMELINE =
  process.env.TABLE_SLOT_TIMELINE || "tickin_timeline_events";
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

/* ✅ Get Driver Name */
async function getDriverName(driverId) {
  if (!driverId) return null;

  try {
    const pk = String(driverId || "").startsWith("USER#")
      ? String(driverId)
      : `USER#${driverId}`;

    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { pk, sk: "PROFILE" }, // ✅ users table uses PROFILE in your code
      })
    );

    const d = res.Item;
    if (!d) return null;

    return d.name || d.userName || d.fullName || d.mobile || null;
  } catch (e) {
    return null;
  }
}

/* ✅ Force display time (IST) */
function prettyTime(ev) {
  const t = ev?.displayTime || ev?.createdAt || ev?.timestamp || null;
  if (!t) return null;

  if (typeof t === "string" && /[A-Za-z]{3}/.test(t) && /AM|PM/i.test(t))
    return t;

  const dt = dayjs(t);
  if (!dt.isValid()) return String(t);

  return dt.tz(IST).format("DD MMM YYYY, hh:mm A");
}

/* ✅ Build Neat Timeline (GAP FIX + alias mapping) */
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

  const ALIAS = {
    LOAD_START: "LOADING_START",
    LOAD_END: "LOADING_COMPLETED",
    LOADING_STARTED: "LOADING_START",
  };

  const map = {};
  for (const e of events) {
    if (!e?.event) continue;

    let key = String(e.event).trim().toUpperCase();
    if (ALIAS[key]) key = ALIAS[key];

    if (!map[key]) {
      map[key] = e;
    } else {
      const oldT = new Date(map[key].createdAt || map[key].timestamp || 0);
      const newT = new Date(e.createdAt || e.timestamp || 0);
      if (newT > oldT) map[key] = e;
    }
  }

  let maxDoneIdx = -1;
  STEPS.forEach((s, idx) => {
    if (map[s.key]) maxDoneIdx = Math.max(maxDoneIdx, idx);
  });

  return STEPS.map((s, idx) => {
    const ev = map[s.key] || null;

    let status = "UPCOMING";
    if (idx < maxDoneIdx) status = "DONE";
    if (ev) status = "DONE";
    if (!ev && idx === maxDoneIdx + 1) status = "CURRENT";

    return {
      step: idx + 1,
      key: s.key,
      title: s.label,
      status,
      time: ev ? prettyTime(ev) : null,
      data: ev?.data || null,
      raw: ev,
    };
  });
}

/* ✅ Fetch Raw */
async function fetchRawTimeline(orderId) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLE_TIMELINE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ORDER#${orderId}` },
      ScanIndexForward: true,
    })
  );
  return out.Items || [];
}

/* ✅ Trim child timeline only till SLOT booking */
function trimPreMerge(neatList = []) {
  const cutoffKeys = new Set(["SLOT_BOOKING", "SLOT_BOOKING_COMPLETED"]);

  const out = [];
  for (const step of neatList) {
    out.push(step);
    const key = String(step?.key || "").toUpperCase();
    if (cutoffKeys.has(key)) break;
  }
  return out;
}

/* ✅ Build Meta (IMPORTANT FIX: mergedOrderIds support) */
async function buildMeta(meta) {
  const driverId =
    meta.driverId || meta.driverUserId || meta.driverMobile || null;

  const driverName = await getDriverName(driverId);

  // ✅ childOrderIds fallback to mergedOrderIds
  const childOrderIds = Array.isArray(meta.childOrderIds)
    ? meta.childOrderIds
    : Array.isArray(meta.mergedOrderIds)
      ? meta.mergedOrderIds
      : [];

  const isMerged = Boolean(
    meta.isMerged ||
      meta.mergedAt ||
      (Array.isArray(childOrderIds) && childOrderIds.length > 0)
  );

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

    isMerged,
    childOrderIds: childOrderIds.map(String),
    mergedAt: meta.mergedAt || meta.mergedOn || meta.mergedTime || null,
  };
}

/* ✅ Helper: Build preMerge block for merged FULL order */
async function buildPreMergeIfNeeded(uiMeta) {
  if (!uiMeta?.isMerged) return null;
  if (!Array.isArray(uiMeta.childOrderIds) || uiMeta.childOrderIds.length === 0)
    return null;

  const kids = uiMeta.childOrderIds.map(String);
  const pre = {};

  for (const kidId of kids) {
    const childRaw = await fetchRawTimeline(kidId);
    const childNeat = buildNeatTimeline(childRaw);
    pre[kidId] = trimPreMerge(childNeat);
  }

  return pre;
}

/* ✅ GET Order Timeline (RAW + NEAT + META + preMerge) */
export async function getOrderTimeline(req, res) {
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

    const meta = orderMetaRes.Item;
    if (!meta)
      return res.status(404).json({ ok: false, message: "Order not found" });

    const user = req.user || {};
    const role = String(user.role || "").toUpperCase();

    if (role !== "MASTER" && role !== "MANAGER") {
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

      if (role === "DRIVER") {
        const loggedDriverId = String(user.userId || user.id || user.mobile || "");
        const orderDriverId = String(meta.driverId || "");

        if (orderDriverId && orderDriverId !== loggedDriverId) {
          return res.status(403).json({ ok: false, message: "Not allowed" });
        }
      }
    }

    const rawTimeline = await fetchRawTimeline(targetOrderId);
    const neatTimeline = buildNeatTimeline(rawTimeline);
    const uiMeta = await buildMeta(meta);

    // ✅ NEW: preMerge for merged FULL order (D1/D2 separate till slot booking)
    const preMerge = await buildPreMergeIfNeeded(uiMeta);

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      meta: uiMeta,
      timeline: rawTimeline,
      neatTimeline,
      preMerge, // ✅ added here so frontend need not change endpoint
    });
  } catch (e) {
    console.error("getOrderTimeline error:", e);
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

/* ✅ GET Order Timeline (NEAT ONLY) */
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

    const rawTimeline = await fetchRawTimeline(targetOrderId);
    const neatTimeline = buildNeatTimeline(rawTimeline);

    const uiMeta = await buildMeta(meta);

    const preMerge = await buildPreMergeIfNeeded(uiMeta);

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      meta: uiMeta,
      preMerge,     // ✅ fixed now (mergedOrderIds supported)
      neatTimeline,
    });
  } catch (e) {
    console.error("getOrderTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

/* ✅ GET Slot Timeline (RAW + NEAT) */
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
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

/* ✅ GET Slot Timeline (NEAT ONLY) */
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
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}
