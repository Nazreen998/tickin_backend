import dayjs from "dayjs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

/**
 * ✅ Timeline Event Writer
 * - supports both data + extra (backward compatibility)
 */
export const addTimelineEvent = async ({
  orderId,
  event,
  by,
  byUserName = null,
  role = null,

  data = {},
  extra = {}, // ✅ allow existing route code

  eventId = null,
  eventAt = null,
}) => {
  const timestamp = eventAt || new Date().toISOString();
  const evt = String(event || "").trim().toUpperCase();

  if (!orderId) throw new Error("orderId required");
  if (!evt) throw new Error("event required");

  const sk = `TS#${timestamp}#EVT#${evt}`;

  // ✅ merge both into one payload
  const finalData = {
    ...(data || {}),
    ...(extra || {}),
  };

  const item = {
    pk: `ORDER#${orderId}`,
    sk,
    orderId,

    event: evt,
    step: evt,
    status: "DONE",

    timestamp,
    displayTime: dayjs(timestamp).format("DD MMM YYYY, hh:mm A"),

    by: String(by || ""),
    byUserName: byUserName ? String(byUserName) : null,
    role: role ? String(role) : null,

    eventId: eventId ? String(eventId) : null,

    data: finalData,
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
