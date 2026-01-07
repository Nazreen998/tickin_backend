import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";

// ✅ timeline helper (your existing module)
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = process.env.DRIVER_GSI || "driverId-index";

// 30 meters
const REACH_RADIUS_METERS = 30;

/* ------------------ helpers ------------------ */

function orderKey(orderId) {
  return { pk: `ORDER#${orderId}`, sk: "META" };
}

function toIsoNow() {
  return new Date().toISOString();
}

// Haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function normalizeDistributors(order) {
  // order.distributors should be like:
  // [{ distributorCode, distributorName, lat, lng, items:[...] }, ...]
  const list = Array.isArray(order.distributors) ? order.distributors : [];
  return list.map((d) => ({
    distributorCode: d.distributorCode || d.code || null,
    distributorName: d.distributorName || d.name || null,
    lat: d.lat ?? null,
    lng: d.lng ?? null,
    items: Array.isArray(d.items) ? d.items : [],
    reachedAt: d.reachedAt || null,
    unloadStartAt: d.unloadStartAt || null,
    unloadEndAt: d.unloadEndAt || null,
  }));
}

function getCurrentStop(order) {
  const distributors = normalizeDistributors(order);
  const idx = Number(order.currentDistributorIndex || 0);
  return { distributors, idx, stop: distributors[idx] || null };
}

/* ------------------ core ------------------ */

// ✅ Get order by orderId (correct pk/sk)
export async function getOrder(orderId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: orderKey(orderId),
    })
  );
  return res.Item || null;
}

// ✅ Driver active orders fetch (for card list)
export async function getDriverOrders(driverId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: DRIVER_GSI,
      KeyConditionExpression: "driverId = :d",
      ExpressionAttributeValues: {
        ":d": String(driverId),
      },
    })
  );

  const allowed = new Set([
    "DRIVER_ASSIGNED",
    "DRIVER_STARTED",
    "DRIVER_REACHED_DISTRIBUTOR",
    "UNLOAD_START",
    "UNLOAD_END",
  ]);

  // ✅ show only active trips (warehouse reached means closed -> hide)
  return (res.Items || []).filter((o) => allowed.has(String(o.status || "").toUpperCase()));
}

// ✅ Validate driver reach within 30m for current distributor stop
export async function validateDriverReach30m({ orderId, currentLat, currentLng }) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const { idx, stop } = getCurrentStop(order);
  if (!stop) throw new Error("No distributor stop found for this order");

  if (stop.lat == null || stop.lng == null) {
    throw new Error("Distributor lat/lng missing for current stop");
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
    distributorCode: stop.distributorCode,
    distributorName: stop.distributorName,
  };
}

// ✅ Driver status update (Strict flow + merge(D1/D2) support + timeline save)
export async function updateDriverStatus({ orderId, nextStatus, currentLat, currentLng, force }) {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  const currentStatus = String(order.status || "").toUpperCase();
  const desired = String(nextStatus || "").toUpperCase();

  validateTransition(currentStatus, desired);

  // Prepare multi-stop state
  const { distributors, idx, stop } = getCurrentStop(order);
  let newIdx = idx;
  let newDistributors = distributors;

  // Reach validation only when reaching distributor
  if (desired === "DRIVER_REACHED_DISTRIBUTOR") {
    if (!stop) throw new Error("No distributor stop found");
    if (!force) {
      if (currentLat == null || currentLng == null) {
        throw new Error("currentLat/currentLng required for reach validation");
      }
      const check = await validateDriverReach30m({
        orderId,
        currentLat,
        currentLng,
      });
      if (!check.within) {
        throw new Error(`Not within ${REACH_RADIUS_METERS}m. Distance: ${check.distanceMeters}m`);
      }
    }

    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      reachedAt: toIsoNow(),
    };
  }

  if (desired === "UNLOAD_START") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadStartAt: toIsoNow(),
    };
  }

  if (desired === "UNLOAD_END") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = {
      ...newDistributors[idx],
      unloadEndAt: toIsoNow(),
    };

    // ✅ move to next distributor if exists (merge case)
    if (idx + 1 < newDistributors.length) {
      newIdx = idx + 1;
    }
  }

  // ✅ if last distributor done, next should be WAREHOUSE_REACHED (enforced by transitions util)
  // We'll store tripClosed on warehouse reached.
  const tripClosed = desired === "WAREHOUSE_REACHED";

  // ✅ DynamoDB conditional update prevents skipping / double click race
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

  // ✅ Timeline event save (single line sequence)
  // If merged slots: store stage D1/D2 via index
  const stage = desired === "WAREHOUSE_REACHED"
    ? "WAREHOUSE"
    : `D${(newIdx || 0) + 1}`;

  const stopForEvent =
    desired === "WAREHOUSE_REACHED"
      ? null
      : (newDistributors[idx] || null);

  await addTimelineEvent({
    orderId,
    event: desired,
    by: String(after.driverId || "DRIVER"),
    role: "DRIVER",
    data: {
      slotId: after.slotId || null,
      mergeKey: after.mergeKey || null,
      stage,
      stopIndex: idx,
      distributorCode: stopForEvent?.distributorCode || null,
      distributorName: stopForEvent?.distributorName || null,
      currentLat: currentLat == null ? null : Number(currentLat),
      currentLng: currentLng == null ? null : Number(currentLng),
    },
  });

  return after;
}
