import { ddb } from "../src/config/dynamo.js";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DIST_TABLE = process.env.DISTRIBUTORS_TABLE || "tickin_distributors";

async function patch(orderId) {
  // get order
  const orderRes = await ddb.send(new GetCommand({
    TableName: ORDERS_TABLE,
    Key: { pk: `ORDER#${orderId}`, sk: "META" }
  }));
  const order = orderRes.Item;
  if (!order) throw new Error("Order not found");

  // get distributor master
  const code = order.distributorId; // D031
  const distRes = await ddb.send(new GetCommand({
    TableName: DIST_TABLE,
    Key: { pk: "DISTRIBUTOR", sk: String(code) }
  }));
  const dist = distRes.Item;
  if (!dist) throw new Error("Distributor not found");

  const mapUrl = dist.final_url || dist.finalUrl || null;

  const distributors = [{
    distributorCode: String(code),
    distributorName: order.distributorName || dist.agencyName || null,
    mapUrl,
    items: order.items || [],
    reachedAt: null,
    unloadStartAt: null,
    unloadEndAt: null
  }];

  await ddb.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression: "SET distributors = :d, currentDistributorIndex = :i",
    ExpressionAttributeValues: { ":d": distributors, ":i": 0 }
  }));

  console.log("✅ patched", orderId);
}

await patch("ORD158d3d3e");
