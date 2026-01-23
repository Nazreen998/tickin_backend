import "dotenv/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "tickin_distributors";
const REGION = process.env.AWS_REGION || "ap-south-1";

const START = { lat: 9.8846830, lng: 78.1432800 }; // given start point

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

async function scanAllActiveWithCoords() {
  let items = [];
  let lastKey = undefined;

  while (true) {
    const out = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ExclusiveStartKey: lastKey,
        // reduce payload
        ProjectionExpression:
          "pk, sk, distributorCode, agencyName, phone, active, lat, lng, final_url",
        // only active and with coords
        FilterExpression:
          "active = :t AND attribute_exists(lat) AND attribute_exists(lng)",
        ExpressionAttributeValues: { ":t": true },
      })
    );

    items.push(...(out.Items || []));
    lastKey = out.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return items;
}

async function main() {
  const items = await scanAllActiveWithCoords();

  const ranked = items
    .map((it) => {
      const lat = Number(it.lat);
      const lng = Number(it.lng);
      const d = haversineKm(START, { lat, lng });
      return {
        sk: it.sk,
        distributorCode: it.distributorCode,
        agencyName: it.agencyName,
        phone: it.phone,
        lat,
        lng,
        distanceKm: Number(d.toFixed(3)),
      };
    })
    .filter((x) => Number.isFinite(x.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  console.table(ranked.slice(0, 4));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
