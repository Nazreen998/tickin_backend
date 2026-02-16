import { ddb } from "../config/dynamo.js";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransition } from "../utils/driverTransitions.js";
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const DRIVER_GSI = "GSI_DRIVER_ASSIGNED";
const WAREHOUSE_LAT = Number(process.env.WAREHOUSE_LAT);
const WAREHOUSE_LNG = Number(process.env.WAREHOUSE_LNG);

const REACH_RADIUS_METERS =
  Number(process.env.REACH_RADIUS_METERS) || 200;

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
  // ✅ Support BOTH DocumentClient + Raw Dynamo JSON
  const unwrap = (v) => {
    if (v == null) return null;
    if (typeof v === "object") {
      if ("S" in v) return v.S;
      if ("N" in v) return Number(v.N);
      if ("BOOL" in v) return Boolean(v.BOOL);
      if ("NULL" in v) return null;
      if ("M" in v) return v.M;
      if ("L" in v) return v.L;
    }
    return v;
  };

  const raw = order?.distributors;

  // ✅ list can be: [] OR {L:[{M:{...}}]}
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.L)) list = raw.L.map((x) => x.M ?? x);
  else list = [];

  function parseLatLngFromUrl(url) {
    if (!url) return { lat: null, lng: null };
    const m = String(url).match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
    if (!m) return { lat: null, lng: null };
    return { lat: Number(m[1]), lng: Number(m[3]) };
  }

  return list.map((d0) => {
    const d = d0?.M ? d0.M : d0;

let lat =
  unwrap(d.lat ?? d.latitude ?? d.distributorLat ?? d.distributor_lat);

let lng =
  unwrap(d.lng ?? d.longitude ?? d.distributorLng ?? d.distributor_lng);

    const mapUrl = unwrap(d.mapUrl ?? d.final_url ?? d.finalUrl);

    if ((lat == null || lng == null) && mapUrl) {
      const parsed = parseLatLngFromUrl(mapUrl);
      lat = lat ?? parsed.lat;
      lng = lng ?? parsed.lng;
    }

    return {
      distributorCode: unwrap(d.distributorCode ?? d.code) ?? null,
      distributorName: unwrap(d.distributorName ?? d.name) ?? null,
      lat: lat == null ? null : Number(lat),
      lng: lng == null ? null : Number(lng),
      mapUrl: mapUrl ?? null,
      items: Array.isArray(unwrap(d.items)) ? unwrap(d.items) : [],
      reachedAt: unwrap(d.reachedAt) ?? null,
      unloadStartAt: unwrap(d.unloadStartAt) ?? null,
      unloadEndAt: unwrap(d.unloadEndAt) ?? null,
    };
  });
}

function getCurrentStop(order) {
  let distributors = normalizeDistributors(order);

  // 🔥 ULTIMATE FALLBACK (MERGE SAFE)
  if (!Array.isArray(distributors) || distributors.length === 0) {
    if (order.distributorName) {
      distributors = [
        {
          distributorCode: order.distributorCode || order.distributorId || null,
          distributorName: order.distributorName,
          lat: Number(order.lat) || Number(order.distributorLat) || null,
          lng: Number(order.lng) || Number(order.distributorLng) || null,
          mapUrl: order.mapUrl || null,
          reachedAt: null,
          unloadStartAt: null,
          unloadEndAt: null,
          items: order.items || [],
        },
      ];
    }
  }

  if (!distributors.length) {
    console.error("❌ NO DISTRIBUTORS EVEN AFTER FALLBACK", order.orderId);
  }

  const idx = Number(order.currentDistributorIndex || 0);

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

/* ------- hydrate driver list ------- */
function sumOrderTotalsFromDistributors(order = {}) {
  const dists = Array.isArray(order.distributors) ? order.distributors : [];
  let totalQty = 0;
  let totalAmount = 0;

  for (const d of dists) {
    const items = Array.isArray(d.items) ? d.items : [];
    for (const it of items) {
      totalQty += Number(it.qty || 0);
      totalAmount += Number(it.total || 0);
    }
  }

  return { totalQty, totalAmount };
}

function buildDistributorDisplay(order = {}) {
  const dists = Array.isArray(order.distributors) ? order.distributors : [];
  if (dists.length === 0) return order.distributorName || "-";
  if (dists.length === 1) return dists[0]?.distributorName || "-";
  return dists.map((d, i) => `D${i + 1}: ${d.distributorName || "-"}`).join(" | ");
}

function hydrateDriverCard(order = {}) {
  const out = { ...order };

  // 1️⃣ recompute totals from distributors.items ALWAYS
  let totalQty = 0;
  let totalAmount = 0;

  const dists = Array.isArray(out.distributors) ? out.distributors : [];

  for (const d of dists) {
    const items = Array.isArray(d.items) ? d.items : [];
    for (const it of items) {
      totalQty += Number(it.qty || 0);
      totalAmount += Number(it.total || 0);
    }
  }

  out.totalQty =
    Number(out.totalQty ?? out.qty ?? totalQty ?? 0);

  out.totalAmount =
    Number(out.totalAmount ?? out.grandTotal ?? totalAmount ?? 0);

  // 2️⃣ distributorDisplay guarantee
  if (!out.distributorDisplay) {
    if (dists.length === 1) {
      out.distributorDisplay = dists[0]?.distributorName || "-";
    } else if (dists.length > 1) {
      out.distributorDisplay = dists
        .map((d, i) => `D${i + 1}: ${d.distributorName || "-"}`)
        .join(" | ");
    } else {
      out.distributorDisplay = out.distributorName || "-";
    }
  }

  // 3️⃣ distributorName fallback
  if (!out.distributorName || out.distributorName === "-") {
    out.distributorName = out.distributorDisplay;
  }

  return out;
}
/**-------GET DRIVER ORDERS--------*/
export async function getDriverOrders(driverId) {
  if (!driverId) return [];

  const rawId = String(driverId).replace("USER#", "");
  const pkId = rawId.startsWith("USER#") ? rawId : `USER#${rawId}`;

  // 🔥 Query BOTH possibilities
  const [resRaw, resPk] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: ORDERS_TABLE,
        IndexName: DRIVER_GSI,
        KeyConditionExpression: "driverId = :d",
        ExpressionAttributeValues: { ":d": rawId },
        ScanIndexForward: false,
      })
    ),
    ddb.send(
      new QueryCommand({
        TableName: ORDERS_TABLE,
        IndexName: DRIVER_GSI,
        KeyConditionExpression: "driverId = :d",
        ExpressionAttributeValues: { ":d": pkId },
        ScanIndexForward: false,
      })
    ),
  ]);

  const allItems = [...(resRaw.Items || []), ...(resPk.Items || [])];

  // ✅ REMOVE DUPLICATES by orderId
  const uniqueMap = new Map();
  for (const o of allItems) {
    const oid = o?.orderId ? String(o.orderId) : null;
    if (!oid) continue;
    uniqueMap.set(oid, o);
  }
  const uniqueOrders = Array.from(uniqueMap.values());

  // ✅ Allowed statuses only (driver screen show)
  const allowed = new Set([
    "DRIVER_ASSIGNED",
    "LOADING_STARTED",
    "LOADING_COMPLETED",
    "DRIVER_STARTED",
    "DRIVE_STARTED",
    "REACHED_D1",
    "REACHED_D2",
    "UNLOADING_START_D1",
    "UNLOADING_START_D2",
    "UNLOADING_END_D1",
    "UNLOADING_END_D2",
    "WAREHOUSE_REACHED",
    "DELIVERY_COMPLETED",
  ]);

  return uniqueOrders
    .filter((o) => o.deletedByDriver !== true)
    .filter((o) => String(o.status || "").toUpperCase() !== "CONFIRMED")
    .filter((o) => String(o.status || "").toUpperCase() !== "MERGED")
    .filter((o) => allowed.has(String(o.status || "").toUpperCase()))
    .map(hydrateDriverCard);
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

/* ------------------ UxPDATE STATUS ------------------ */
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

  let desired = incoming;

  if (incoming === "DRIVER_STARTED") desired = "DRIVER_STARTED";
  if (incoming === "DRIVE_STARTED") desired = "DRIVER_STARTED";
  if (incoming === "DRIVER_REACHED_DISTRIBUTOR") desired = reachedEventKey(idx);
  if (incoming === "UNLOAD_START") desired = unloadStartEventKey(idx);
  if (incoming === "UNLOAD_END") desired = unloadEndEventKey(idx);

  if (
    !hasD2 &&
    ["REACHED_D2", "UNLOADING_START_D2", "UNLOADING_END_D2"].includes(desired)
  ) {
    throw new Error("D2 not applicable for single order");
  }

  validateTransition(currentStatus, desired);
// ✅ WAREHOUSE REACHED → location validation
if (desired === "WAREHOUSE_REACHED") {
  if (!isFiniteLatLng(WAREHOUSE_LAT, WAREHOUSE_LNG)) {
    throw new Error("Warehouse location missing or invalid");
  }

  if (!force) {
    if (!isFiniteLatLng(currentLat, currentLng)) {
      throw new Error("currentLat/currentLng required");
    }

    const dist = haversineMeters(
      Number(currentLat),
      Number(currentLng),
      WAREHOUSE_LAT,
      WAREHOUSE_LNG
    );

    if (dist > REACH_RADIUS_METERS) {
      return {
        ok: false,
        reached: false,
        message: "Try again",
        distanceMeters: Math.round(dist),
        radiusMeters: REACH_RADIUS_METERS,
      };
    }
  }
}


  let newIdx = idx;
  let newDistributors = distributors;

    if (desired === "REACHED_D1" || desired === "REACHED_D2") {
    if (!stop) throw new Error("No distributor stop found");

    // ✅ DEBUG (Render logs la paaka)
    console.log("------ REACH DEBUG ------");
    console.log("orderId:", orderId, "idx:", idx);
    console.log("STOP:", stop);
    console.log("STOP LAT:", stop?.lat, "STOP LNG:", stop?.lng);
    console.log("DRIVER LAT:", currentLat, "DRIVER LNG:", currentLng);
    console.log("-------------------------");

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
          distributorLat: check.distributorLat,
          distributorLng: check.distributorLng,
        };
      }
    }

    newDistributors = [...newDistributors];
    newDistributors[idx] = { ...newDistributors[idx], reachedAt: toIsoNow() };
  }

  if (desired === "UNLOADING_START_D1" || desired === "UNLOADING_START_D2") {
    if (!stop) throw new Error("No distributor stop found");
    newDistributors = [...newDistributors];
    newDistributors[idx] = { ...newDistributors[idx], unloadStartAt: toIsoNow() };
  }

  if (desired === "UNLOADING_END_D1" || desired === "UNLOADING_END_D2") {
    if (!stop) throw new Error("No distributor stop found");

    newDistributors = [...newDistributors];
    newDistributors[idx] = { ...newDistributors[idx], unloadEndAt: toIsoNow() };

    if (idx + 1 < newDistributors.length) {
      newIdx = idx + 1;
    }
  }

  const tripClosed =
    desired === "WAREHOUSE_REACHED" || desired === "DELIVERY_COMPLETED";

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
