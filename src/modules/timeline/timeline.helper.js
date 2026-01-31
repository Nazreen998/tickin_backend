import dayjs from "dayjs";
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { handleTimelineNotification } from "../notifications/timelineNotification.helper.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = "Asia/Kolkata";

const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";
const TABLE_ORDER_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_SLOT_TIMELINE =
  process.env.TABLE_SLOT_TIMELINE || "tickin_timeline_events";

/**
 * ✅ Resolve Timeline Target Order
 * - If HALF order merged -> write into FULL master order timeline
 */
async function resolveTimelineOrderId(orderId) {
  if (!orderId) return null;

  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    const meta = res.Item;
    if (!meta) return orderId;

    if (meta.mergedIntoOrderId) return String(meta.mergedIntoOrderId);

    return orderId;
  } catch (e) {
    return orderId;
  }
}

/**
 * ✅ ORDER Timeline Event Writer
 */
export const addTimelineEvent = async ({
  orderId,
  event,
  by,
  byUserName = null,
  role = null,
  data = {},
  eventId = null,
  eventAt = null,
}) => {
  const timestamp = eventAt || new Date().toISOString();
  const evt = String(event || "").trim().toUpperCase();

  if (!orderId) throw new Error("orderId required");
  if (!evt) throw new Error("event required");

  // ✅ redirect if merged
  const targetOrderId = await resolveTimelineOrderId(orderId);

  const sk = `TS#${timestamp}#EVT#${evt}`;

  const item = {
    pk: `ORDER#${targetOrderId}`,
    sk,
    orderId: targetOrderId,

    event: evt,
    step: evt,
    status: "DONE",

    timestamp,
    // ✅ IST display time
    displayTime: dayjs(timestamp).tz(IST).format("DD MMM YYYY, hh:mm A"),

    by: String(by || ""),
    byUserName: byUserName ? String(byUserName) : null,
    role: role ? String(role) : null,

    eventId: eventId ? String(eventId) : null,
    data: data || {},
    createdAt: timestamp,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_ORDER_TIMELINE,
      Item: item,
      ConditionExpression: eventId ? "attribute_not_exists(eventId)" : undefined,
    })
  );
  // 🔔 auto notification based on EVENT_ROLE_MAP
  await handleTimelineNotification({
    event: evt,
    orderId: targetOrderId, // ✅ use resolved id
    data,
  });


  return true;
};

/**
 * ✅ SLOT Timeline Event Writer
 * - slotId + orderId both reference
 */
export const addSlotTimelineEvent = async ({
  slotId,
  orderId = null,
  event,
  by,
  byUserName = null,
  role = null,
  distributorName = null,
  amount = 0,
  data = {},
  eventId = null,
  eventAt = null,
}) => {
  const timestamp = eventAt || new Date().toISOString();
  const evt = String(event || "").trim().toUpperCase();

  if (!slotId) throw new Error("slotId required");
  if (!evt) throw new Error("event required");

  const sk = `TS#${timestamp}#EVT#${evt}`;

  const item = {
    pk: `SLOT#${String(slotId)}`,
    sk,

    slotId: String(slotId),
    orderId: orderId ? String(orderId) : null,

    event: evt,
    step: evt,
    status: "DONE",

    timestamp,
    // ✅ IST display time
    displayTime: dayjs(timestamp).tz(IST).format("DD MMM YYYY, hh:mm A"),

    distributorName: distributorName ? String(distributorName) : null,
    amount: Number(amount || 0),

    by: String(by || ""),
    byUserName: byUserName ? String(byUserName) : null,
    role: role ? String(role) : null,

    eventId: eventId ? String(eventId) : null,
    data: data || {},
    createdAt: timestamp,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_SLOT_TIMELINE,
      Item: item,
      ConditionExpression: eventId ? "attribute_not_exists(eventId)" : undefined,
    })
  );

  return true;
};
// ✅ Mark master order as merged and store child orderIds
export async function markOrderAsMerged({ fullOrderId, childOrderIds = [] }) {
  if (!fullOrderId) throw new Error("fullOrderId required");

  const now = new Date().toISOString();
  const kids = Array.from(
    new Set((childOrderIds || []).filter(Boolean).map((x) => String(x)))
  );

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${String(fullOrderId)}`, sk: "META" },
      UpdateExpression:
        "SET isMerged=:m, childOrderIds=:c, mergedAt=:t, updatedAt=:t",
      ExpressionAttributeValues: {
        ":m": true,
        ":c": kids,
        ":t": now,
      },
    })
  );

  return true;
}
