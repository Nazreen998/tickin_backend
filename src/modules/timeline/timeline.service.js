import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";
const TABLE_SLOT_TIMELINE =
  process.env.TABLE_SLOT_TIMELINE || "tickin_timeline_events";

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

/* ✅ Build Neat Timeline (Fixed Steps + DONE/CURRENT/UPCOMING) */
function buildNeatTimeline(events = []) {
  const STEPS = [
    { key: "ORDER_CREATED", label: "Order Created" },
    { key: "ORDER_CONFIRMED", label: "Order Confirmed" },
    { key: "SLOT_BOOKING", label: "Slot Booking" },
    { key: "SLOT_BOOKING_COMPLETED", label: "Slot Booking Completed" },
    { key: "VEHICLE_SELECTED", label: "Vehicle Selected" },
    { key: "LOAD_START", label: "Loading Start" },
    { key: "LOADING_ITEM", label: "Loading Item" }, // optional
    { key: "LOAD_END", label: "Loading End" },
    { key: "DRIVER_ASSIGNED", label: "Driver Assigned" },
    { key: "DRIVE_STARTED", label: "Drive Started" },
    { key: "REACHED_D1", label: "Reached D1" },
    { key: "UNLOADING_START_D1", label: "Unloading Start D1" },
    { key: "UNLOADING_END_D1", label: "Unloading End D1" },
    { key: "REACHED_D2", label: "Reached D2" },
    { key: "UNLOADING_START_D2", label: "Unloading Start D2" },
    { key: "UNLOADING_END_D2", label: "Unloading End D2" },
    { key: "WAREHOUSE_REACHED", label: "Warehouse Reached" },
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

  // ✅ find last done step index
  let lastDoneIdx = -1;
  STEPS.forEach((s, idx) => {
    if (map[s.key]) lastDoneIdx = idx;
  });

  // ✅ build neat step list
  return STEPS.map((s, idx) => {
    const ev = map[s.key] || null;

    let status = "UPCOMING";
    if (ev) status = "DONE";
    else if (idx === lastDoneIdx + 1) status = "CURRENT";

    return {
      step: idx + 1,
      key: s.key,
      title: s.label,
      status, // DONE / CURRENT / UPCOMING
      time: ev?.displayTime || ev?.createdAt || ev?.timestamp || null,
      data: ev?.data || null,
      raw: ev,
    };
  });
}

/* ✅ GET Order Timeline Controller
   GET /api/timeline/:orderId
*/
export async function getOrderTimeline(req, res) {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId required" });
    }

    // ✅ resolve merged FULL orderId
    const targetOrderId = await resolveTargetOrderId(orderId);

    // ✅ fetch order meta for auth check
    const orderMetaRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${targetOrderId}`, sk: "META" },
      })
    );

    const meta = orderMetaRes.Item;
    if (!meta) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    const user = req.user || {};
    const role = String(user.role || "").toUpperCase();

    // ✅ Restrict distributor/sales to only own order
    if (
      role === "DISTRIBUTOR" ||
      role === "SALESMAN" ||
      role === "SALES OFFICER"
    ) {
      const metaUserId = String(meta.userId || meta.createdBy || "");
      const loggedUserId = String(user.userId || user.id || user.mobile || "");

      if (metaUserId !== loggedUserId) {
        return res.status(403).json({ ok: false, message: "Not allowed" });
      }
    }

    // ✅ query timeline (oldest -> latest)
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

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      timeline: rawTimeline,
      neatTimeline,
    });
  } catch (e) {
    console.error("getOrderTimeline error:", e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e),
    });
  }
}

/* ✅ GET Slot Timeline Controller
   GET /api/timeline/slot/:slotId
*/
export async function getSlotTimeline(req, res) {
  try {
    const { slotId } = req.params;

    if (!slotId) {
      return res.status(400).json({ ok: false, message: "slotId required" });
    }

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

    return res.json({
      ok: true,
      slotId,
      timeline: rawTimeline,
      neatTimeline,
    });
  } catch (e) {
    console.error("getSlotTimeline error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/* ✅ ONLY neat response (optional)
   GET /api/timeline/:orderId/neat
*/
export async function getOrderTimelineNeat(req, res) {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId required" });
    }

    const targetOrderId = await resolveTargetOrderId(orderId);

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

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      neatTimeline,
    });
  } catch (e) {
    console.error("getOrderTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/* ✅ ONLY slot neat response
   GET /api/timeline/slot/:slotId/neat
*/
export async function getSlotTimelineNeat(req, res) {
  try {
    const { slotId } = req.params;
    if (!slotId) {
      return res.status(400).json({ ok: false, message: "slotId required" });
    }

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

    return res.json({
      ok: true,
      slotId,
      neatTimeline,
    });
  } catch (e) {
    console.error("getSlotTimelineNeat error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}
