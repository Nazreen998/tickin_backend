import { ddb } from "../../config/dynamo.js";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_TIMELINE = process.env.TABLE_TIMELINE || "tickin_timeline";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

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

/* ✅ GET Timeline Controller
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
    if (role === "DISTRIBUTOR" || role === "SALESMAN" || role === "SALES OFFICER") {
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

    return res.json({
      ok: true,
      requestedOrderId: orderId,
      orderId: targetOrderId,
      timeline: out.Items || [],
    });
  } catch (e) {
    console.error("getOrderTimeline error:", e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e),
    });
  }
}
