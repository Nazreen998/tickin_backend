import dayjs from "dayjs";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

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
 * ✅ (Existing) ORDER Timeline Event Writer
 * - Keeps old working logic
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
    displayTime: dayjs(timestamp).format("DD MMM YYYY, hh:mm A"),

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

  return true;
};

/**
 * ✅ NEW: SLOT Timeline Event Writer (Single-line append)
 * - Every event saved as a new row
 * - slotId + orderId both reference (for monthly review)
 */
export const addSlotTimelineEvent = async ({
  slotId,
  orderId = null, // optional
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
    displayTime: dayjs(timestamp).format("DD MMM YYYY, hh:mm A"),

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
