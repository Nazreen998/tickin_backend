import { ddb } from "../src/config/dynamo.js";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DIST_TABLE = process.env.DISTRIBUTORS_TABLE || "tickin_distributors";

const orderId = "ORD806caac7";

async function run() {
  // 1) get order
  const orderRes = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );
  const order = orderRes.Item;
  if (!order) throw new Error("Order not found");

  const distributorId = order.distributorId;
  if (!distributorId) throw new Error("distributorId missing in order");

  // 2) get distributor
  const distRes = await ddb.send(
    new GetCommand({
      TableName: DIST_TABLE,
      Key: { pk: "DISTRIBUTOR", sk: String(distributorId) },
    })
  );
  const dist = distRes.Item;
  if (!dist) throw new Error("Distributor not found");

  const lat = dist.lat ?? null;
  const lng = dist.lng ?? null;
  if (lat == null || lng == null) throw new Error("Distributor lat/lng missing");

  // 3) patch distributors[0].lat/lng
  const distributors = Array.isArray(order.distributors) ? [...order.distributors] : [];
  if (!distributors[0]) throw new Error("order.distributors[0] missing");

  distributors[0] = {
    ...distributors[0],
    lat: Number(lat),
    lng: Number(lng),
  };

  await ddb.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression: "SET distributors = :d, updatedAt = :u",
      ExpressionAttributeValues: {
        ":d": distributors,
        ":u": new Date().toISOString(),
      },
    })
  );

  console.log("✅ Updated", orderId, "lat/lng:", lat, lng);
}

run().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
