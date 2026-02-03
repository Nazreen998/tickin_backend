import { ddb } from "../../config/dynamo.js";
import "../../config/env.js";

import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  resolveOrderIdsFromFlowKey,
  normalizeOrderId,
} from "../../utils/orderResolver.js";

import { normalizeUserPk } from "../../utils/userUtils.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

// 🔧 ONE-TIME FIX FOR OLD ORDERS (lat/lng missing)
export const fixDistributors = async (req, res) => {
  try {
    const { orderId, lat, lng } = req.body;

    if (!orderId || !lat || !lng) {
      return res.status(400).json({
        ok: false,
        message: "orderId, lat, lng required",
      });
    }

    const getRes = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!getRes.Item) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    let distributors = Array.isArray(getRes.Item.distributors)
      ? getRes.Item.distributors
      : [];

    distributors = distributors.map((d) => ({
      ...d,
      lat: d.lat ?? Number(lat),
      lng: d.lng ?? Number(lng),
    }));

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

    return res.json({
      ok: true,
      message: "✅ Distributors fixed",
      count: distributors.length,
    });
  } catch (err) {
    console.error("fixDistributors error", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
};

function parseLatLngFromUrl(url) {
  if (!url) return { lat: null, lng: null };
  const m = String(url).match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (!m) return { lat: null, lng: null };
  return { lat: Number(m[1]), lng: Number(m[3]) };
}

function normalizeStop(d = {}) {
  let lat = d.lat ?? d.latitude ?? null;
  let lng = d.lng ?? d.longitude ?? null;
  const mapUrl = d.mapUrl ?? d.final_url ?? d.finalUrl ?? null;

  // if lat/lng missing, try parse from mapUrl
  if ((!lat || !lng) && mapUrl) {
    const p = parseLatLngFromUrl(mapUrl);
    lat = lat ?? p.lat;
    lng = lng ?? p.lng;
  }

  return {
    distributorCode: d.distributorCode || d.code || d.distributorId || null,
    distributorName: d.distributorName || d.name || null,
    lat: lat == null ? null : Number(lat),
    lng: lng == null ? null : Number(lng),
    mapUrl,
    items: Array.isArray(d.items) ? d.items : [],
    reachedAt: d.reachedAt || null,
    unloadStartAt: d.unloadStartAt || null,
    unloadEndAt: d.unloadEndAt || null,
  };
}

/* ============================================================
   ✅ ASSIGN DRIVER (FULL + MERGE SAFE)
   - FULL order gets driver + distributors[]
   - CHILD orders => MERGED
   - Driver side D1 / D2 works
============================================================ */
// export const assignDriver = async (req, res) => {
//   try {
//     const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
//     const { driverId, vehicleNo } = req.body;

//     if (!key || !driverId) {
//       return res.status(400).json({
//         ok: false,
//         message: "flowKey & driverId required",
//       });
//     }
//     /* --------------------------------------------------
//        1️⃣ Resolve orderIds
//     -------------------------------------------------- */
//     const rawOrderIds = await resolveOrderIdsFromFlowKey(key);
//     if (!rawOrderIds || rawOrderIds.length === 0) {
//       return res.status(404).json({
//         ok: false,
//         message: "No orders found for flow",
//       });
//     }

//     const orderIds = rawOrderIds.map(normalizeOrderId).filter(Boolean);

//     /* --------------------------------------------------
//        2️⃣ Find FULL order
//     -------------------------------------------------- */
//     const fullOrderId =
//       orderIds.find((x) => x.startsWith("ORD_FULL_")) || null;

//     if (!fullOrderId) {
//       return res.status(400).json({
//         ok: false,
//         message: "Merged flow must contain ORD_FULL order",
//       });
//     }

//     const childOrderIds = orderIds.filter((id) => id !== fullOrderId);

//     /* --------------------------------------------------
//        🔧 helper: extract lat/lng safely (🔥 IMPORTANT)
//     -------------------------------------------------- */
//     function extractLatLng(o = {}) {
//       if (Number(o.lat) && Number(o.lng)) {
//         return { lat: Number(o.lat), lng: Number(o.lng) };
//       }

//       if (Number(o.distributorLat) && Number(o.distributorLng)) {
//         return {
//           lat: Number(o.distributorLat),
//           lng: Number(o.distributorLng),
//         };
//       }

//       if (o.mapUrl) {
//         const m = String(o.mapUrl).match(
//           /(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/,
//         );
//         if (m) {
//           return { lat: Number(m[1]), lng: Number(m[3]) };
//         }
//       }

//       return { lat: null, lng: null };
//     }

//     /* --------------------------------------------------
//        3️⃣ BUILD distributors[] FOR FULL ORDER
//     -------------------------------------------------- */
//     let distributors = [];

//     // 🔹 3A: from FULL order (if already exists)
//     const fullRes = await ddb.send(
//       new GetCommand({
//         TableName: ORDERS_TABLE,
//         Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
//       }),
//     );

//     if (Array.isArray(fullRes.Item?.distributors)) {
//       distributors.push(...fullRes.Item.distributors);
//     }

//     // 🔹 3B: from CHILD orders
//     for (const cid of childOrderIds) {
//       const g = await ddb.send(
//         new GetCommand({
//           TableName: ORDERS_TABLE,
//           Key: { pk: `ORDER#${cid}`, sk: "META" },
//         }),
//       );

//       const o = g.Item;
//       if (!o) continue;

//       // CASE 1: already has distributors[]
//       if (Array.isArray(o.distributors) && o.distributors.length > 0) {
//         distributors.push(...o.distributors);
//         continue;
//       }

//       // CASE 2: single-order shape → BUILD distributor
//       if (o.distributorName) {  let lat =
//     Number(o.lat) ||
//     Number(o.distributorLat) ||
//     null;

//   let lng =
//     Number(o.lng) ||
//     Number(o.distributorLng) ||
//     null;

//   // 🔥 HARD FALLBACK (same location allowed)
//   if (!lat || !lng) {
//     // 🔁 COPY FROM PREVIOUS DISTRIBUTOR IF EXISTS
//     const prev = distributors[distributors.length - 1];
//     if (prev?.lat && prev?.lng) {
//       lat = prev.lat;
//       lng = prev.lng;
//     }
//   }
//         if (!lat || !lng) continue; // 🔥 THIS LINE IS CRITICAL
//         distributors.push({
//           distributorCode: o.distributorId || null,
//           distributorName: o.distributorName,
//           lat: lat ?? null,
//           lng: lng ?? null,
//           mapUrl: o.mapUrl || null,
//           items: o.items || [],
//           reachedAt: null,
//           unloadStartAt: null,
//           unloadEndAt: null,
//         });
//       }
//     }
//     // 🔥 ADD THIS LINE
// distributors = distributors.map(normalizeStop);
//     /* --------------------------------------------------
//        4️⃣ DEDUPE distributors
//     -------------------------------------------------- */
//     const seen = new Set();
//     distributors = distributors.filter((d) => {
//       const k = (d.distributorCode || d.distributorName || "")
//         .toString()
//         .trim()
//         .toUpperCase();
//       if (!k || seen.has(k)) return false;
//       seen.add(k);
//       return true;
//     });

//     if (!distributors.length) {
//       return res.status(400).json({
//         ok: false,
//         message: "No valid distributor locations found",
//       });
//     }

//     /* --------------------------------------------------
//        5️⃣ Driver lookup
//     -------------------------------------------------- */
//     const driverPk = normalizeUserPk(driverId);
//     const dg = await ddb.send(
//       new GetCommand({
//         TableName: USERS_TABLE,
//         Key: { pk: driverPk, sk: "PROFILE" },
//       }),
//     );

//     if (!dg.Item) {
//       return res.status(404).json({
//         ok: false,
//         message: "Driver not found",
//       });
//     }

//     const driverName = dg.Item.name || dg.Item.userName || "Driver";
//     const driverMobile = dg.Item.mobile || null;

//     /* --------------------------------------------------
//        6️⃣ UPDATE FULL ORDER (🔥 FINAL FIX)
//     -------------------------------------------------- */
//     await ddb.send(
//       new UpdateCommand({
//         TableName: ORDERS_TABLE,
//         Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
//         UpdateExpression: `
//           SET #s = :st,
//               driverId = :d,
//               driverName = :dn,
//               driverMobile = :dm,
//               vehicleNo = :vn,
//               distributors = :dist,
//               currentDistributorIndex = :i
//         `,
//         ExpressionAttributeNames: { "#s": "status" },
//         ExpressionAttributeValues: {
//           ":st": "DRIVER_ASSIGNED",
//           ":d": driverPk,
//           ":dn": driverName,
//           ":dm": driverMobile,
//           ":vn": vehicleNo || null,
//           ":dist": distributors,
//           ":i": 0,
//         },
//       }),
//     );

//     /* --------------------------------------------------
//        7️⃣ CHILD ORDERS → MERGED
//     -------------------------------------------------- */
//     for (const cid of childOrderIds) {
//       await ddb.send(
//         new UpdateCommand({
//           TableName: ORDERS_TABLE,
//           Key: { pk: `ORDER#${cid}`, sk: "META" },
//           UpdateExpression:
//             "SET #s = :st, mergedIntoOrderId = :mid REMOVE driverId, driverName, driverMobile",
//           ExpressionAttributeNames: { "#s": "status" },
//           ExpressionAttributeValues: {
//             ":st": "MERGED",
//             ":mid": fullOrderId,
//           },
//         }),
//       );
//     }

//     /* --------------------------------------------------
//        8️⃣ Timeline (ONLY FULL)
//     -------------------------------------------------- */
//     const user = req.user || {};
//     await addTimelineEvent({
//       orderId: fullOrderId,
//       event: "DRIVER_ASSIGNED",
//       by: user.mobile || "system",
//       byUserName: user.name || user.userName || null,
//       role: user.role || "MANAGER",
//       data: {
//         flowKey: key,
//         driverId: driverPk,
//         driverName,
//         driverMobile,
//         vehicleNo: vehicleNo || null,
//       },
//     });

//     return res.json({
//       ok: true,
//       message: "✅ Driver assigned successfully",
//       fullOrderId,
//       distributorCount: distributors.length,
//     });
//   } catch (err) {
//     console.error("assignDriver error", err);
//     return res.status(500).json({
//       ok: false,
//       message: err.message,
//     });
//   }
// };
/* ============================================================
   ✅ DRIVER DROPDOWN
============================================================ */
export const getDriversForDropdown = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "#r = :d",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":d": "DRIVER" },
        ProjectionExpression: "pk, name, userName, mobile",
      })
    );

    const drivers = (result.Items || []).map((u) => ({
      driverId: u.pk,
      name: u.name || u.userName || "Driver",
      mobile: u.mobile || null,
    }));

    return res.json({ ok: true, drivers });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
};
