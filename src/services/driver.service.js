import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = process.env.DRIVER_GSI || "driverId-index";

// ✅ Get order by orderId
export async function getOrder(orderId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
    })
  );
  return res.Item;
}

// ✅ Driver status update (Strict flow + multi distributor support)
export async function updateDriverStatus(orderId, nextStatus) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const currentStatus = order.status;
  validateTransition(currentStatus, nextStatus);

  let distributors = order.distributors || [];
  let idx = order.currentDistributorIndex || 0;

  // ✅ Distributor progress update only for these statuses
  if (["DRIVER_REACHED_DISTRIBUTOR", "UNLOAD_START", "UNLOAD_END"].includes(nextStatus)) {
    if (!distributors[idx]) throw new Error("Distributor missing for current index");

    if (nextStatus === "DRIVER_REACHED_DISTRIBUTOR") distributors[idx].reached = true;
    if (nextStatus === "UNLOAD_START") distributors[idx].unloadStart = true;

    if (nextStatus === "UNLOAD_END") {
      distributors[idx].unloadEnd = true;

      // ✅ If next distributor exists, move index forward
      if (idx + 1 < distributors.length) idx++;
    }
  }

  // ✅ DynamoDB conditional update prevents skipping / double request race
  const updated = await ddb.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },

      ConditionExpression: "#s = :current",
      UpdateExpression:
        "SET #s = :next, distributors = :d, currentDistributorIndex = :i, updatedAt = :u",

      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":current": currentStatus,
        ":next": nextStatus,
        ":d": distributors,
        ":i": idx,
        ":u": Date.now(),
      },

      ReturnValues: "ALL_NEW",
    })
  );

  return updated.Attributes;
}

// ✅ Driver active orders fetch (for card)
export async function getDriverOrders(driverId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: DRIVER_GSI,
      KeyConditionExpression: "driverId = :d",
      ExpressionAttributeValues: {
        ":d": driverId,
      },
    })
  );

  const allowed = new Set([
    "DRIVER_ASSIGNED",
    "DRIVER_STARTED",
    "DRIVER_REACHED_DISTRIBUTOR",
    "UNLOAD_START",
    "UNLOAD_END",
    "WAREHOUSE_REACHED",
  ]);

  return (res.Items || []).filter((o) => allowed.has(o.status));
}
