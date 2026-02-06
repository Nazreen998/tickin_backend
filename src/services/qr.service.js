import { ddb } from "../config/dynamo.js";
import {
  QueryCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";

const QR_ITEMS = "qr_items";
const QR_TX = "qr_transactions";

const pk = (q) => `QR#${q}`;
const batchSk = (id) => `BATCH#${id}`;

export async function getActiveBatch(qrName) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: QR_ITEMS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk(qrName) }
    })
  );

  return res.Items?.find((i) => i.status === "ACTIVE");
}
export async function getQrHistory() {
  const res = await ddb.send(
    new ScanCommand({
      TableName: QR_ITEMS,
      FilterExpression: "#s = :a",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":a": "ACTIVE" }
    })
  );

  const items = res.Items || [];

  // sort A1..A200 properly
  items.sort((a, b) => {
    const na = parseInt((a.qrName || "").replace(/[^\d]/g, "")) || 0;
    const nb = parseInt((b.qrName || "").replace(/[^\d]/g, "")) || 0;
    return na - nb;
  });

  return items;
}
export async function takeStock(qrName, qty, user) {
  if (!qty || qty <= 0) throw new Error("Invalid quantity");

  const active = await getActiveBatch(qrName);
  if (!active) throw new Error("No active batch");

  if (active.availableQty < qty) {
    throw new Error("Insufficient stock");
  }

  const now = new Date().toISOString();
  const afterQty = active.availableQty - qty;

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: QR_ITEMS,
            Key: { pk: active.pk, sk: active.sk },
            UpdateExpression: "SET availableQty = :a",
            ConditionExpression: "availableQty = :b",
            ExpressionAttributeValues: {
              ":a": afterQty,
              ":b": active.availableQty
            }
          }
        },
        {
          Put: {
            TableName: QR_TX,
            Item: {
              pk: pk(qrName),
              sk: `TX#${now}`,
              action: "TAKE",
              quantity: qty,
              user,
              at: now
            }
          }
        }
      ]
    })
  );

  return { before: active.availableQty, after: afterQty };
}

export async function addNewBatch(data) {
  const { qrName, totalQty, itemName, ml, mfgDate, expiryDate, user } = data;

  const active = await getActiveBatch(qrName);
  if (active && active.availableQty !== 0) {
    throw new Error("Stock not zero");
  }

  const now = new Date().toISOString();

  if (active) {
    await ddb.send(
      new UpdateCommand({
        TableName: QR_ITEMS,
        Key: { pk: active.pk, sk: active.sk },
        UpdateExpression: "SET #s = :c",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":c": "CLOSED" }
      })
    );
  }

  const item = {
    pk: pk(qrName),
    sk: batchSk(now),
    qrName,
    itemName,
    ml,
    mfgDate,
    expiryDate,
    totalQty,
    availableQty: totalQty,
    status: "ACTIVE",
    createdAt: now,
    createdBy: user
  };

  await ddb.send(
    new PutCommand({
      TableName: QR_ITEMS,
      Item: item
    })
  );

  return item;
}
