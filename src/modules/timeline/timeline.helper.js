import dayjs from "dayjs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

/**
 * ✅ NEAT Timeline Event Writer (Mongo Style)
 * - No spread extra
 * - Everything goes inside data{}
 * - Standard keys always same
 */
export const addTimelineEvent = async ({
  orderId,
  event,
  by,
  byUserName = null,
  role = null,
  data = {},

  // Optional: stop duplicate insert (ex: "SLOT_BOOKED#ORD#DATE")
  eventId = null,
  eventAt = null,
}) => {
  const timestamp = eventAt || new Date().toISOString();
  const evt = String(event || "").trim().toUpperCase();
  if (!orderId) throw new Error("orderId required");
  if (!evt) throw new Error("event required");

  const sk = `TS#${timestamp}#EVT#${evt}`;

  const item = {
    pk: `ORDER#${orderId}`,
    sk,
    orderId,

    event: evt,
    step: evt, // ✅ later mapping can override
    status: "DONE",

    timestamp,
    displayTime: dayjs(timestamp).format("DD MMM YYYY, hh:mm A"),

    by: String(by || ""),
    byUserName: byUserName ? String(byUserName) : null,
    role: role ? String(role) : null,

    eventId: eventId ? String(eventId) : null,

    // ✅ all extra goes only here
    data: data || {},
    createdAt: timestamp,
  };

  await ddb.send(
    new PutCommand({
      TableName: "tickin_timeline",
      Item: item,
      ConditionExpression: eventId
        ? "attribute_not_exists(eventId)"
        : undefined,
    })
  );

  return true;
};
