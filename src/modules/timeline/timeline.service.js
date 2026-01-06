import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

/* ✅ If HALF order merged -> resolve FULL master orderId */
async function resolveTargetOrderId(orderId) {
  if (!orderId) return null;

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  if (!res.Item) return orderId;

  if (res.Item.mergedIntoOrderId) {
    return String(res.Item.mergedIntoOrderId);
  }

  return orderId;
}

/* ✅ GET /timeline/:orderId */
export async function getOrderTimeline(req, res) {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: "orderId required",
      });
    }

    // ✅ redirect to FULL order if merged
    const targetOrderId = await resolveTargetOrderId(orderId);

    const pk = `ORDER#${targetOrderId}`;

    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
        ScanIndexForward: true, // oldest -> latest
      })
    );

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      timeline: out.Items || [],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || String(e),
    });
  }
}
