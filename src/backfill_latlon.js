import "dotenv/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import pLimit from "p-limit";

const TABLE = "tickin_distributors";
const REGION = process.env.AWS_REGION || "ap-south-1";

// tune these
const CONCURRENCY = 8;          // parallel updates
const PAGE_LIMIT = 200;         // scan page size

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  {
    marshallOptions: { removeUndefinedValues: true }
  }
);

function extractLatLngFromGoogleMapsUrl(url) {
  if (!url || typeof url !== "string") return null;

  // Pattern 1: !3dLAT!4dLNG
  let m = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), source: "!3d!4d" };

  // Pattern 2: @LAT,LNG,ZOOM
  m = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), source: "@" };

  return null;
}

async function scanPage(lastKey) {
  const cmd = new ScanCommand({
    TableName: TABLE,
    Limit: PAGE_LIMIT,
    ExclusiveStartKey: lastKey,
    // only items that have final_url AND don't already have lat/lng
    FilterExpression:
      "attribute_exists(final_url) AND (attribute_not_exists(lat) OR attribute_not_exists(lng))",
    ProjectionExpression: "pk, sk, final_url, lat, lng",
  });

  return ddb.send(cmd);
}

async function updateItem(pk, sk, lat, lng) {
  const now = new Date().toISOString();

  const cmd = new UpdateCommand({
    TableName: TABLE,
    Key: { pk, sk },
    UpdateExpression: "SET lat = :lat, lng = :lng, updatedAt = :u",
    ExpressionAttributeValues: {
      ":lat": lat,
      ":lng": lng,
      ":u": now,
    },
    // prevent accidental overwrite if some other process set it just now
    ConditionExpression: "attribute_not_exists(lat) OR attribute_not_exists(lng)",
  });

  return ddb.send(cmd);
}

async function main() {
  let lastKey = undefined;
  let scanned = 0;
  let matched = 0;
  let updated = 0;
  let skippedNoCoords = 0;
  let conditionFailed = 0;
  let errors = 0;

  const limit = pLimit(CONCURRENCY);

  console.log(`Starting backfill on ${TABLE} (region=${REGION})`);

  while (true) {
    const page = await scanPage(lastKey);
    scanned += page.ScannedCount || 0;

    const items = page.Items || [];
    matched += items.length;

    const tasks = items.map((it) =>
      limit(async () => {
        try {
          const url = it.final_url;
          const coords = extractLatLngFromGoogleMapsUrl(url);
          if (!coords) {
            skippedNoCoords++;
            return;
          }

          await updateItem(it.pk, it.sk, coords.lat, coords.lng);
          updated++;
        } catch (e) {
          // ConditionalCheckFailedException => someone already updated
          if (e?.name === "ConditionalCheckFailedException") {
            conditionFailed++;
            return;
          }
          errors++;
          console.error("Update failed:", { pk: it.pk, sk: it.sk, err: e?.message || e });
        }
      })
    );

    await Promise.all(tasks);

    console.log(
      `Progress: scanned=${scanned}, matched=${matched}, updated=${updated}, noCoords=${skippedNoCoords}, condFail=${conditionFailed}, errors=${errors}`
    );

    lastKey = page.LastEvaluatedKey;
    if (!lastKey) break;
  }

  console.log("DONE", {
    scanned,
    matched,
    updated,
    skippedNoCoords,
    conditionFailed,
    errors,
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
