import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { dispatchEvent } from "./dispatchEvent.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";

/**
 * 🔔 Handle notifications triggered by timeline events
 * - Uses EVENT_ROLE_MAP as source of truth
 */
export async function handleTimelineNotification({
  event,
  orderId,
  data = {},
}) {
  const evt = String(event || "").trim().toUpperCase();

  console.log("🔔 TIMELINE_NOTIFICATION_HANDLER", { evt, orderId });

  // ✅ If event not configured for notification → exit
  if (!EVENT_ROLE_MAP[evt]) {
    console.log("🔕 EVENT_NOT_CONFIGURED_FOR_NOTIFICATION", evt);
    return;
  }

  // ✅ Fetch order meta
  const orderRes = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  const order = orderRes.Item;
  if (!order) {
    console.log("❌ ORDER_NOT_FOUND_FOR_NOTIFICATION", orderId);
    return;
  }

  // ✅ Dispatch
  await dispatchEvent(
    evt,
    {
      orderId: order.orderId,
      orderNo: order.orderId,
      distributorName: order.distributorName,
      amount: order.totalAmount,
      ...data,
    },
    { order }
  );

  console.log("✅ NOTIFICATION_DISPATCHED", evt, orderId);
}
