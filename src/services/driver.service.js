import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = "GSI_DRIVER_ASSIGNED";

// ✅ 150m = 1500 meters
//const REACH_RADIUS_METERS = 150 * 100;
const REACH_RADIUS_METERS = 20;

/* ------------------ helpers ------------------ */

function orderKey(orderId) {
  return { pk: `ORDER#${orderId}`, sk: "META" };
}

function toIsoNow() {
  return new Date().toISOString();
}

function isFiniteLatLng(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === 0 || ln === 0) return false;
  if (la < -90 || la > 90) return false;
  if (ln < -180 || ln > 180) return false;
  return true;
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

  const lat1N = Number(lat1);
  const lon1N = Number(lon1);
  const lat2N = Number(lat2);
  const lon2N = Number(lon2);

  if (!isFiniteLatLng(lat1N, lon1N) || !isFiniteLatLng(lat2N, lon2N)) return Infinity;

  const dLat = toRad(lat2N - lat1N);
  const dLon = toRad(lon2N - lon1N);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1N)) *
      Math.cos(toRad(lat2N)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* -------- distributors -------- */

function normalizeDistributors(order) {
  const list = Array.isArray(order.distributors) ? order.distributors : [];

  return list.map((d) => {
    // ✅ support mapUrl + final_url + finalUrl
    const url = d.mapUrl || d.final_url || d.finalUrl || null;
    const parsed = extractLatLngFromUrl(url);

    const lat = d.lat ?? d.latitude ?? parsed.lat ?? null;
    const lng = d.lng ?? d.longitude ?? parsed.lng ?? null;

    return {
      distributorCode: d.distributorCode || d.code || null,
      distributorName: d.distributorName || d.name || null,
      lat,
      lng,
      mapUrl: url,
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

  // ✅ safeguard: idx out of bounds
  if (!Number.isFinite(idx) || idx < 0) {
    return { distributors, idx: 0, stop: distributors[0] || null };
  }

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

  return (res.Items || []).filter((o) => allowed.has(String(o.status || "").toUpperCase()));
}

/* -------- distance validation -------- */

// ✅ name keep same for compatibility, but now it checks 50km
export async function validateDriverReach30m({ orderId, currentLat, currentLng }) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const { idx, stop } = getCurrentStop(order);
  if (!stop) throw new Error("No distributor stop found");

  if (!isFiniteLatLng(stop.lat, stop.lng)) {
    throw new Error("Distributor location missing or invalid");
  }

  if (!isFiniteLatLng(currentLat, currentLng)) {
    throw new Error("Driver location missing or invalid");
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
    radiusMeters: REACH_RADIUS_METERS,
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
    if (!stop) throw new Error("No distributor stop found");

    if (!force) {
      if (!isFiniteLatLng(stop.lat, stop.lng)) {
        throw new Error("Distributor location missing or invalid");
      }

      if (!isFiniteLatLng(currentLat, currentLng)) {
        throw new Error("currentLat/currentLng required");
      }

      const check = await validateDriverReach30m({ orderId, currentLat, currentLng });

      // ✅ IMPORTANT: “Try again” should not throw
      if (!check.within) {
        return {
          ok: false,
          reached: false,
          message: "Try again",
          distanceMeters: check.distanceMeters,
          radiusMeters: check.radiusMeters,
          currentStopIndex: check.currentStopIndex,
        };
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

  // ✅ If we returned Try again above, we won't reach here (no DB update)
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
    reached: desired === "DRIVER_REACHED_DISTRIBUTOR" ? true : undefined,
    order: after,
  };
}
