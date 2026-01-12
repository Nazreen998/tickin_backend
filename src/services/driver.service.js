import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = "GSI_DRIVER_ASSIGNED";
const REACH_RADIUS_METERS = 100;

/* ------------------ helpers ------------------ */

function orderKey(orderId) {
  return { pk: `ORDER#${orderId}`, sk: "META" };
}

function toIsoNow() {
  return new Date().toISOString();
}

/* -------- Google Maps URL → lat/lng -------- */

function extractLatLngFromUrl(url) {
  if (!url || typeof url !== "string") {
    return { lat: null, lng: null };
  }

  let match;

  // !3dLAT!4dLNG
  match = url.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  if (match) {
    return { lat: Number(match[1]), lng: Number(match[3]) };
  }

  // @LAT,LNG
  match = url.match(/@(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)/);
  if (match) {
    return { lat: Number(match[1]), lng: Number(match[3]) };
  }

  // LAT,LNG
  match = url.match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (match) {
    return { lat: Number(match[1]), lng: Number(match[3]) };
  }

  return { lat: null, lng: null };
}

/* -------- distance -------- */

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* -------- distributors -------- */

function normalizeDistributors(order) {
  const list = Array.isArray(order.distributors) ? order.distributors : [];

  return list.map((d) => {
    const parsed = extractLatLngFromUrl(d.mapUrl);

    return {
      distributorCode: d.distributorCode || d.code || null,
      distributorName: d.distributorName || d.name || null,
      lat: d.lat ?? d.latitude ?? parsed.lat ?? null,
      lng: d.lng ?? d.longitude ?? parsed.lng ?? null,
      mapUrl: d.mapUrl || null,
      items: Array.isArray(d.items) ? d.items : [],
      reachedAt: d.reachedAt || null,
      unloadStartAt: d.unloadStartAt || null,
      unloadEndAt: d.unloadEndAt || null,
    };
  });
}

function getCurrentStop(order) {
  const distributors = normalizeDistributors(order);
  const idx = Number(order.currentDistributorIndex || 0);
  return { distributors, idx, stop: distributors[idx] || null };
}

/* ------------------ core ------------------ */

export async function getOrder(orderId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: orderKey(orderId),
    })
  );
  return res.Item || null;
}

export async function getDriverOrders(driverId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: DRIVER_GSI,
      KeyConditionExpression: "driverId = :d",
      ExpressionAttributeValues: { ":d": String(driverId) },
      ScanIndexForward: false,
    })
  );

  const allowed = new Set([
    "DRIVER_ASSIGNED",
    "DRIVER_STARTED",
    "DRIVER_REACHED_DISTRIBUTOR",
    "UNLOAD_START",
    "UNLOAD_END",
  ]);

  return (res.Items || []).filter((o) =>
    allowed.has(String(o.status || "").toUpperCase())
  );
}

/* -------- distance validation -------- */

export async function validateDriverReach30m({
  orderId,
  currentLat,
  currentLng,
}) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const { idx, stop } = getCurrentStop(order);
  if (!stop || stop.lat == null || stop.lng == null) {
    throw new Error("Distributor location missing or invalid");
  }

  const dist = haversineMeters(
    Number(currentLat),
    Number(currentLng),
    Number(stop.lat),
    Number(stop.lng)
  );

  return {
    within: dist <= REACH_RADIUS_METERS,
    distanceMeters: Math.round(dist),
    currentStopIndex: idx,
    distributorLat: stop.lat,
    distributorLng: stop.lng,
  };
}

/* ------------------ UPDATE STATUS (FINAL) ------------------ */

export async function updateDriverStatus({
  orderId,
  nextStatus,
  currentLat,
  currentLng,
  force = false,
}) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const currentStatus = String(order.status || "").toUpperCase();
  const desired = String(nextStatus || "").toUpperCase();

  validateTransition(currentStatus, desired);

  const { distributors, idx, stop } = getCurrentStop(order);
  console.log("📍 CURRENT STOP:", stop, "🔥 FORCE:", force);

  let newIdx = idx;
  let newDistributors = distributors;

  /* ---------- DRIVER_REACHED_DISTRIBUTOR ---------- */
  if (desired === "DRIVER_REACHED_DISTRIBUTOR") {
    if (!force) {
      if (!stop || stop.lat == null || stop.lng == null) {
        throw new Error("Distributor location missing or invalid");
      }

      if (currentLat == null || currentLng == null) {
        throw new Error("currentLat/currentLng required");
      }

      const check = await validateDriverReach30m({
        orderId,
        currentLat,
        currentLng,
      });

      if (!check.within) {
        throw new Error(
          `Not within ${REACH_RADIUS_METERS}m. Distance: ${check.distanceMeters}m`
        );
      }
    }

    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      reachedAt: toIsoNow(),
    };
  }

  /* ---------- UNLOAD_START ---------- */
  if (desired === "UNLOAD_START") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadStartAt: toIsoNow(),
    };
  }

  /* ---------- UNLOAD_END ---------- */
  if (desired === "UNLOAD_END") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadEndAt: toIsoNow(),
    };

    if (idx + 1 < newDistributors.length) {
      newIdx = idx + 1;
    }
  }

  const tripClosed = desired === "WAREHOUSE_REACHED";

  const updated = await ddb.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: orderKey(orderId),
      ConditionExpression: "#s = :current",
      UpdateExpression:
        "SET #s = :next, distributors = :d, currentDistributorIndex = :i, tripClosed = :c, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":current": currentStatus,
        ":next": desired,
        ":d": newDistributors,
        ":i": newIdx,
        ":c": Boolean(tripClosed),
        ":u": toIsoNow(),
      },
      ReturnValues: "ALL_NEW",
    })
  );

  const after = updated.Attributes || {};

  await addTimelineEvent({
    orderId,
    event: desired,
    by: String(after.driverId || "DRIVER"),
    role: "DRIVER",
    data: {
      stage: desired === "WAREHOUSE_REACHED" ? "WAREHOUSE" : `D${newIdx + 1}`,
      stopIndex: idx,
      currentLat,
      currentLng,
    },
  });

  return {
    ok: true,
    order: after,
  };
}
