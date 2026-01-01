import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

/**
 * ✅ Adds one timeline event per row
 * - sk includes timestamp + event for clarity
 * - optional eventId to prevent duplicates (same event pressed twice)
 */
export const addTimelineEvent = async ({
  orderId,
  event,
  by,
  extra = {},
  eventId = null, // pass something unique if needed (ex: "LOAD_START" or "SLOT_BOOKED#2026-01-01#D002")
}) => {
  const timestamp = new Date().toISOString();
  const evt = String(event || "").trim().toUpperCase();

  if (!orderId) throw new Error("orderId required");
  if (!evt) throw new Error("event required");

  // ✅ Better sort key
  const sk = `TIME#${timestamp}#EVT#${evt}`;

  await ddb.send(
    new PutCommand({
      TableName: "tickin_timeline",
      Item: {
        pk: `ORDER#${orderId}`,
        sk,
        orderId,
        event: evt,
        by: String(by || ""),
        timestamp,
        eventId: eventId ? String(eventId) : null,
        ...extra,
      },
      // ✅ Optional duplicate protection (only if you pass eventId)
      // If you don’t pass eventId, this still works normally.
      ConditionExpression: eventId
        ? "attribute_not_exists(eventId)"
        : undefined,
    })
  );

  return true;
};
