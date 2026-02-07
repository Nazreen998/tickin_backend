import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";

export async function resolveOrderIdsFromFlowKey(flowKey) {
  if (!flowKey) return [];

  // already array
  if (Array.isArray(flowKey)) {
    return flowKey.map(normalizeOrderId).filter(Boolean);
  }

  const key = String(flowKey).trim();
  if (!key) return [];

  // comma separated
  if (key.includes(",")) {
    return key
      .split(",")
      .map((k) => normalizeOrderId(k))
      .filter(Boolean);
  }

  /* ============================================================
     CASE 1: ORD_FULL_xxx
  ============================================================ */
  if (key.startsWith("ORD_FULL_")) {
    const fg = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${key}`, sk: "META" },
      })
    );

    if (!fg.Item) {
      // fallback: try base child order
      const baseOrd = `ORD${key.replace("ORD_FULL_", "")}`;
      return [key, baseOrd];
    }

    const merged =
      fg.Item.mergedOrderIds ||
      fg.Item.childOrderIds ||
      fg.Item.orderIds ||
      [];

    const list = Array.isArray(merged) ? merged : [];

    // include FULL itself always
    return [key, ...list.map(normalizeOrderId).filter(Boolean)];
  }

  /* ============================================================
     CASE 2: ORDxxxx (single)
  ============================================================ */
  if (key.startsWith("ORD") && !key.startsWith("ORD_FULL_")) {
    const fullKey = `ORD_FULL_${key.replace(/^ORD/, "")}`;

    // check if FULL exists
    const fg = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullKey}`, sk: "META" },
      })
    );

    if (fg.Item) {
      const merged =
        fg.Item.mergedOrderIds ||
        fg.Item.childOrderIds ||
        fg.Item.orderIds ||
        [];

      const list = Array.isArray(merged) ? merged : [];

      // include child too
      const out = [fullKey, key, ...list];
      return [...new Set(out.map(normalizeOrderId).filter(Boolean))];
    }

    // no FULL found
    return [key];
  }

  /* ============================================================
     CASE 3: mergeKey / LOC#xxx
  ============================================================ */
  // scan orders where mergeKey = key
  const scan = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: "mergeKey = :mk",
      ExpressionAttributeValues: { ":mk": key },
    })
  );

  const metas = scan.Items || [];
  const ids = metas
    .map((o) => normalizeOrderId(o.orderId || (o.pk ? String(o.pk).replace("ORDER#", "") : null)))
    .filter(Boolean);

  // if we got ORDxxxx, ensure FULL also included
  const fulls = ids
    .filter((x) => x.startsWith("ORD") && !x.startsWith("ORD_FULL_"))
    .map((x) => `ORD_FULL_${x.replace(/^ORD/, "")}`);

  return [...new Set([...ids, ...fulls].map(normalizeOrderId).filter(Boolean))];
}

export function normalizeOrderId(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (!s || s === "null") return null;
  return s;
}
