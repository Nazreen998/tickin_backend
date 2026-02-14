import { ddb } from "../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

export async function resolveTargetOrderId(orderId) {
  if (!orderId) return null;

  const oid = String(orderId).trim();
  if (!oid) return null;

  if (oid.startsWith("ORD") && !oid.startsWith("ORD_FULL_")) {
    const fullKey = `ORD_FULL_${oid.replace(/^ORD/, "")}`;

    const fg = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${fullKey}`, sk: "META" },
      })
    );

    if (fg.Item) return fullKey;
  }

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${oid}`, sk: "META" },
    })
  );

  if (!res.Item) return oid;

  if (res.Item.mergedIntoOrderId)
    return String(res.Item.mergedIntoOrderId);

  return oid;
}
