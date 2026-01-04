import { ddb } from "../../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "tickin_distributors";

function extractLatLngFromFinalUrl(url) {
  if (!url) return { lat: null, lng: null };

  const clean = String(url).trim();

  const m3 = clean.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  if (m3) return { lat: Number(m3[1]), lng: Number(m3[3]) };

  const m4 = clean.match(/[?&]q=(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)/);
  if (m4) return { lat: Number(m4[1]), lng: Number(m4[3]) };

  return { lat: null, lng: null };
}

export async function getDistributorByCode(code) {
  if (!code) throw new Error("distributor code required");

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: "DISTRIBUTOR", sk: code },
    })
  );

  if (!res.Item) throw new Error("Distributor not found");

  const item = res.Item;

  // ✅ Compute lat/lng if missing
  if (item.lat == null || item.lng == null) {
    const url = item.final_url || item.finalUrl || item.finalURL;
    const parsed = extractLatLngFromFinalUrl(url);
    item.lat = parsed.lat;
    item.lng = parsed.lng;
  }

  return item;
}
