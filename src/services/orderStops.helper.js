import { ddb } from "../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const DIST_TABLE = process.env.DISTRIBUTORS_TABLE || "tickin_distributors";

export async function buildOrderStopsFromDistributorId({
  distributorId,
  distributorName,
  items = [],
}) {
  if (!distributorId) return [];

  const distRes = await ddb.send(
    new GetCommand({
      TableName: DIST_TABLE,
      Key: { pk: "DISTRIBUTOR", sk: String(distributorId) },
    })
  );

  const dist = distRes.Item || null;

  const mapUrl = dist?.final_url || dist?.finalUrl || null;
  const lat = dist?.lat ?? dist?.latitude ?? null;
  const lng = dist?.lng ?? dist?.longitude ?? null;

  return [
    {
      distributorCode: String(distributorId),
      distributorName: distributorName || dist?.agencyName || null,
      mapUrl, // ✅ final_url goes here
      lat: lat == null ? null : Number(lat),
      lng: lng == null ? null : Number(lng),
      items: Array.isArray(items) ? items : [],
      reachedAt: null,
      unloadStartAt: null,
      unloadEndAt: null,
    },
  ];
}
