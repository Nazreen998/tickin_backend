import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { resolveTargetOrderId } from "../../utils/order.helper.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = "Asia/Kolkata";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";
const TABLE_SLOT_TIMELINE =
  process.env.TABLE_SLOT_TIMELINE || "tickin_timeline_events";
const TABLE_USERS = process.env.USERS_TABLE || "tickin_users";

function normalizeCode(v) {
  return String(v || "").trim().toUpperCase();
}

function getUserDistributorCodes(user) {
  const codes = [];

  if (user.distributorCode) codes.push(user.distributorCode);
  if (user.distributorCodes) {
    if (Array.isArray(user.distributorCodes)) codes.push(...user.distributorCodes);
    else codes.push(user.distributorCodes);
  }
  if (user.allowedDistributorCodes) {
    if (Array.isArray(user.allowedDistributorCodes)) codes.push(...user.allowedDistributorCodes);
    else codes.push(user.allowedDistributorCodes);
  }

  return [...new Set(codes.map(normalizeCode).filter(Boolean))];
}

function getOrderDistributorCodes(meta) {
  const codes = [];
  if (meta.distributorCode) codes.push(meta.distributorCode);
  if (meta.distributorId) codes.push(meta.distributorId); // your orders store code here sometimes
  if (meta.distributorCodes) {
    if (Array.isArray(meta.distributorCodes)) codes.push(...meta.distributorCodes);
    else codes.push(meta.distributorCodes);
  }
  return [...new Set(codes.map(normalizeCode).filter(Boolean))];
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

/* ✅ Normalize USER PK */
function normalizeUserPk(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  return s.startsWith("USER#") ? s : `USER#${s}`;
}

/* ✅ Get Driver Name (PROFILE/META both) */
async function getDriverName(driverId) {
  if (!driverId) return null;

  try {
    const pk = normalizeUserPk(driverId);
    if (!pk) return null;

    // ✅ Try PROFILE first
    const r1 = await ddb.send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { pk, sk: "PROFILE" },
      })
    );
    const d1 = r1.Item;
    if (d1) return d1.name || d1.userName || d1.fullName || d1.mobile || null;

    // ✅ fallback META
    const r2 = await ddb.send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { pk, sk: "META" },
      })
    );
    const d2 = r2.Item;
    if (d2) return d2.name || d2.userName || d2.fullName || d2.mobile || null;

    return null;
  } catch (e) {
    return null;
  }
}

/* ✅ Force display time (IST) */
function prettyTime(ev) {
  const t =
    ev?.displayTime ||
    ev?.createdAt ||
    ev?.timestamp ||
    ev?.time ||
    null;

  if (!t) return null;

  return t;
}
/* ✅ Build Neat Timeline (alias + gap fix) */
function buildNeatTimeline(events = [], opts = {}) {
  const stopCount = Math.max(1, Number(opts.stopCount || 1));

  // ✅ Dynamic D1..Dn steps
  const STOP_STEPS = [];
  for (let i = 1; i <= stopCount; i++) {
    STOP_STEPS.push(
      { key: `REACHED_D${i}`, label: `Reached D${i}` },
      { key: `UNLOADING_START_D${i}`, label: `Unloading Start D${i}` },
      { key: `UNLOADING_END_D${i}`, label: `Unloading End D${i}` }
    );
  }

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

    ...STOP_STEPS,

    { key: "WAREHOUSE_REACHED", label: "Warehouse Reached" },
    { key: "DELIVERY_COMPLETED", label: "Delivery Completed" },
  ];

  const ALIAS = {
    LOAD_START: "LOADING_START",
    LOAD_END: "LOADING_COMPLETED",
    LOADING_STARTED: "LOADING_START",
    DRIVER_STARTED: "DRIVE_STARTED",
  };

  // keep latest event per key
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

  // gap fix
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
/* ✅ Fetch Raw Timeline */
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

/* ✅ PreMerge: only till SLOT_BOOKING_COMPLETED */
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

/* ✅ PostMerge: start AFTER SLOT_BOOKING_COMPLETED (i.e. from VEHICLE_SELECTED) */
function trimPostMerge(neatList = []) {
  const cutKey = "SLOT_BOOKING_COMPLETED";
  const idx = neatList.findIndex(
    (x) => String(x?.key || "").toUpperCase() === cutKey
  );
  if (idx === -1) return neatList;
  return neatList.slice(idx + 1);
}

/* ✅ Build D1/D2 distributor display (ONLY if merged and >1 child) */
async function buildDistributorDisplay(meta, childIds) {
  const baseName =
    meta.distributorName ||
    meta.distributor ||
    meta.agencyName ||
    meta.customerName ||
    meta.companyName ||
    null;

  const kids = Array.isArray(childIds) ? childIds.map(String).filter(Boolean) : [];

  // ✅ Single => just base name
  if (kids.length <= 1) return baseName;

  const metas = await Promise.all(
    kids.map(async (oid) => {
      try {
        const r = await ddb.send(
          new GetCommand({
            TableName: TABLE_ORDERS,
            Key: { pk: `ORDER#${oid}`, sk: "META" },
          })
        );
        return { oid, meta: r.Item || null };
      } catch (_) {
        return { oid, meta: null };
      }
    })
  );

  const names = metas.map((x, idx) => {
    const nm =
      x?.meta?.distributorName || x?.meta?.distributor || x?.meta?.agencyName || null;
    const label = `D${idx + 1}`;
    return nm ? `${label}: ${String(nm).trim()}` : `${label}: -`;
  });

  return names.join(" | ") || baseName;
}

/* ✅ Build Meta (mergedOrderIds support + driverName + D1/D2 only if merged) */
async function buildMeta(meta) {
  const driverId = meta.driverId || meta.driverUserId || meta.driverMobile || null;
  const driverName = await getDriverName(driverId);

  const childOrderIds = Array.isArray(meta.childOrderIds)
    ? meta.childOrderIds
    : Array.isArray(meta.mergedOrderIds)
      ? meta.mergedOrderIds
      : [];

  const isMerged = Boolean(
    meta.isMerged ||
    meta.mergedAt ||
    (Array.isArray(childOrderIds) && childOrderIds.length > 1)
  );

  let distributorDisplay =
    meta.distributorName ||
    meta.distributor ||
    meta.agencyName ||
    meta.customerName ||
    null;

  // 🔥 IMPORTANT FALLBACK
  if (!distributorDisplay && meta.distributorId) {
    distributorDisplay = meta.distributorId;
  }

  return {
    distributorName: distributorDisplay || "-",
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
    mergedAt: meta.mergedAt || null,
  };
}
/* ✅ Build preMerge map: each child timeline till SLOT_BOOKING_COMPLETED */
async function buildPreMergeIfNeeded(uiMeta) {
  if (!uiMeta?.isMerged) return null;
  const kids = Array.isArray(uiMeta.childOrderIds)
    ? uiMeta.childOrderIds.map(String).filter(Boolean)
    : [];
  if (kids.length <= 1) return null;

  const pre = {};
  for (const kidId of kids) {
    const childRaw = await fetchRawTimeline(kidId);
    const childNeat = buildNeatTimeline(childRaw, { stopCount: 1 });// child always single
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

    // ✅ access control
    const user = req.user || {};
  const role = String(user?.role || "").trim().toUpperCase();
//const isAdmin = ["MASTER", "MANAGER"].includes(role);

// 🔥 HARD ADMIN BYPASS
// ✅ Allow Manager + Distributor + Sales Officer to view timeline freely
//const role = String(req.user?.role || "").trim().toUpperCase();

const allowedRoles = [
  "MASTER",
  "MANAGER",
  "DISTRIBUTOR",
  "SALESMAN",
  "SALES OFFICER",
  "SALES_OFFICER_VNR",
  "DRIVER",
];

if (!allowedRoles.includes(role)) {
  return res.status(403).json({ ok: false, message: "Not allowed" });
}



    const uiMeta = await buildMeta(meta);

  // ✅ stopCount = how many distributors / child orders
const stopCount =
  uiMeta?.isMerged && Array.isArray(uiMeta.childOrderIds) && uiMeta.childOrderIds.length
    ? uiMeta.childOrderIds.length
    : 1;

const rawTimeline = await fetchRawTimeline(targetOrderId);
let neatTimeline = buildNeatTimeline(rawTimeline, { stopCount });


    // ✅ merged common timeline should start AFTER slot booking completed
    if (uiMeta.isMerged) neatTimeline = trimPostMerge(neatTimeline);

    const preMerge = await buildPreMergeIfNeeded(uiMeta);

    return res.json({
  ok: true,

  // 🔥 IMPORTANT: always send FULL id back
  requestedOrderId: targetOrderId,
  orderId: targetOrderId,

  meta: uiMeta,
  timeline: rawTimeline,
  neatTimeline,
  preMerge,
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
    const meta = orderMetaRes.Item;
    if (!meta)
      return res.status(404).json({ ok: false, message: "Order not found" });

    const uiMeta = await buildMeta(meta);
    const stopCount =
  uiMeta?.isMerged && Array.isArray(uiMeta.childOrderIds) && uiMeta.childOrderIds.length
    ? uiMeta.childOrderIds.length
    : 1;

const rawTimeline = await fetchRawTimeline(targetOrderId);
let neatTimeline = buildNeatTimeline(rawTimeline, { stopCount });


    if (uiMeta.isMerged) neatTimeline = trimPostMerge(neatTimeline);

    const preMerge = await buildPreMergeIfNeeded(uiMeta);

  return res.json({
  ok: true,

  // 🔥 IMPORTANT: always send FULL id back
  requestedOrderId: targetOrderId,
  orderId: targetOrderId,

  meta: uiMeta,
  timeline: rawTimeline,
  neatTimeline,
  preMerge,
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
    const neatTimeline = buildNeatTimeline(rawTimeline, { includeD2: true });

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
    const neatTimeline = buildNeatTimeline(rawTimeline, { includeD2: true });

    return res.json({ ok: true, slotId, neatTimeline });
  } catch (e) {
    console.error("getSlotTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}
