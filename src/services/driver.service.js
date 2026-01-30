import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = "GSI_DRIVER_ASSIGNED";

// ✅100 meters
//const REACH_RADIUS_METERS = 100;
const REACH_RADIUS_METERS = 200;

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

/* -------- distance -------- */

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const lat1N = Number(lat1);
  const lon1N = Number(lon1);
  const lat2N = Number(lat2);
  const lon2N = Number(lon2);

  if (!isFiniteLatLng(lat1N, lon1N) || !isFiniteLatLng(lat2N, lon2N))
    return Infinity;

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
    // ✅ NO URL PARSING. Only use stored coordinates.
    const lat = d.lat ?? d.latitude ?? null;
    const lng = d.lng ?? d.longitude ?? null;

    return {
      distributorCode: d.distributorCode || d.code || null,
      distributorName: d.distributorName || d.name || null,
      lat,
      lng,
      // ✅ keep mapUrl if you want, but not used for logic
      mapUrl: d.mapUrl || d.final_url || d.finalUrl || null,
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

  if (!Number.isFinite(idx) || idx < 0) {
    return { distributors, idx: 0, stop: distributors[0] || null };
  }

  return { distributors, idx, stop: distributors[idx] || null };
}

/* ✅ D1 / D2 helpers */
function stopLabel(idx) {
  return idx === 0 ? "D1" : "D2";
}

function reachedEventKey(idx) {
  return idx === 0 ? "REACHED_D1" : "REACHED_D2";
}
function unloadStartEventKey(idx) {
  return idx === 0 ? "UNLOADING_START_D1" : "UNLOADING_START_D2";
}
function unloadEndEventKey(idx) {
  return idx === 0 ? "UNLOADING_END_D1" : "UNLOADING_END_D2";
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

  // ✅ allow all statuses that driver can see
  const allowed = new Set([
    "DRIVER_ASSIGNED",
    "DRIVER_STARTED", // ✅ add
    "DRIVE_STARTED", // keep if old data exists
    "DRIVER_REACHED_DISTRIBUTOR", // ✅ add (safety)
    "UNLOAD_START", // ✅ add
    "UNLOAD_END", // ✅ add

    "REACHED_D1",
    "UNLOADING_START_D1",
    "UNLOADING_END_D1",
    "REACHED_D2",
    "UNLOADING_START_D2",
    "UNLOADING_END_D2",

    "WAREHOUSE_REACHED",
    "DELIVERY_COMPLETED",
  ]);
return (res.Items || []).filter((o) =>
  allowed.has(String(o.status || "").toUpperCase()) &&
  o.deletedByDriver !== true
);
}

/* -------- distance validation -------- */

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

/* ------------------ UPDATE STATUS ------------------ */
/**
 * nextStatus (frontend/driver app) can send:
 *  - DRIVE_STARTED
 *  - DRIVER_REACHED_DISTRIBUTOR   (we convert to REACHED_D1/REACHED_D2)
 *  - UNLOAD_START                 (we convert to UNLOADING_START_D1/D2)
 *  - UNLOAD_END                   (we convert to UNLOADING_END_D1/D2)
 *  - WAREHOUSE_REACHED
 *  - DELIVERY_COMPLETED (optional)
 */
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
  const incoming = String(nextStatus || "").toUpperCase();

  const { distributors, idx, stop } = getCurrentStop(order);
  const totalStops = distributors.length;
  const hasD2 = totalStops > 1;

  // ✅ map generic → timeline keys
  let desired = incoming;

  if (incoming === "DRIVER_STARTED") desired = "DRIVER_STARTED";
  if (incoming === "DRIVE_STARTED") desired = "DRIVER_STARTED"; // alias normalize
  if (incoming === "DRIVER_REACHED_DISTRIBUTOR") desired = reachedEventKey(idx);
  if (incoming === "UNLOAD_START") desired = unloadStartEventKey(idx);
  if (incoming === "UNLOAD_END") desired = unloadEndEventKey(idx);

  // ✅ Single order => never allow D2 events
  if (
    !hasD2 &&
    ["REACHED_D2", "UNLOADING_START_D2", "UNLOADING_END_D2"].includes(desired)
  ) {
    throw new Error("D2 not applicable for single order");
  }

  // ✅ validate transition using your existing rules
  validateTransition(currentStatus, desired);

  let newIdx = idx;
  let newDistributors = distributors;

  /* ---------- DRIVE_STARTED ---------- */
  if (desired === "DRIVE_STARTED") {
    // nothing special, just status update + timeline event below
  }

  /* ---------- REACHED_D1 / REACHED_D2 ---------- */
  if (desired === "REACHED_D1" || desired === "REACHED_D2") {
    if (!stop) throw new Error("No distributor stop found");

    if (!force) {
      if (!isFiniteLatLng(stop.lat, stop.lng)) {
        throw new Error("Distributor location missing or invalid");
      }
      if (!isFiniteLatLng(currentLat, currentLng)) {
        throw new Error("currentLat/currentLng required");
      }

      const check = await validateDriverReach30m({
        orderId,
        currentLat,
        currentLng,
      });
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
    newDistributors[idx] = { ...newDistributors[idx], reachedAt: toIsoNow() };
  }

  /* ---------- UNLOADING_START_D1 / D2 ---------- */
  if (desired === "UNLOADING_START_D1" || desired === "UNLOADING_START_D2") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadStartAt: toIsoNow(),
    };
  }

  /* ---------- UNLOADING_END_D1 / D2 ---------- */
  if (desired === "UNLOADING_END_D1" || desired === "UNLOADING_END_D2") {
    if (!stop) throw new Error("No distributor stop found");

    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadEndAt: toIsoNow(),
    };

    // ✅ after unload end, move to next stop if exists
    if (idx + 1 < newDistributors.length) {
      newIdx = idx + 1;
    }
  }

  const tripClosed =
    desired === "WAREHOUSE_REACHED" || desired === "DELIVERY_COMPLETED";

  // ✅ DB update
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

  // ✅ timeline event (THIS is what your tracking screen reads)
  await addTimelineEvent({
    orderId,
    event: desired,
    by: String(after.driverId || "DRIVER"),
    role: "DRIVER",
    data: {
      stage:
        desired === "WAREHOUSE_REACHED"
          ? "WAREHOUSE"
          : desired === "DELIVERY_COMPLETED"
          ? "DONE"
          : stopLabel(idx),
      stopIndex: idx,
      currentLat,
      currentLng,
    },
  });
  return {
    ok: true,
    reached:
      desired === "REACHED_D1" || desired === "REACHED_D2" ? true : undefined,
    order: after,
  };
}
