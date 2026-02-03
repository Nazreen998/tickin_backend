import { ddb } from "../config/dynamo.js";
import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  resolveOrderIdsFromFlowKey,
  normalizeOrderId,
} from "../utils/orderResolver.js";

import { normalizeUserPk } from "../utils/user.util.js";
import { addTimelineEvent } from "../modules/timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

/* ============================================================
   ✅ ASSIGN DRIVER (FULL + MERGE SAFE)
   - FULL order gets driver + distributors[]
   - CHILD orders => MERGED
   - Driver side D1 / D2 works
============================================================ */
export const assignDriver = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;

    if (!key || !driverId) {
      return res.status(400).json({
        ok: false,
        message: "flowKey & driverId required",
      });
    }

    /* --------------------------------------------------
       1️⃣ Resolve orderIds
    -------------------------------------------------- */
    const rawOrderIds = await resolveOrderIdsFromFlowKey(key);
    if (!rawOrderIds || rawOrderIds.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "No orders found for flow",
      });
    }

    const orderIds = rawOrderIds.map(normalizeOrderId).filter(Boolean);

    /* --------------------------------------------------
       2️⃣ Find FULL order
    -------------------------------------------------- */
    const fullOrderId =
      orderIds.find((x) => x.startsWith("ORD_FULL_")) || null;

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "Merged flow must contain ORD_FULL order",
      });
    }

    const childOrderIds = orderIds.filter((id) => id !== fullOrderId);

    /* --------------------------------------------------
       🔧 helper: extract lat/lng safely (🔥 IMPORTANT)
    -------------------------------------------------- */
    function extractLatLng(o = {}) {
      if (Number(o.lat) && Number(o.lng)) {
        return { lat: Number(o.lat), lng: Number(o.lng) };
      }

      if (Number(o.distributorLat) && Number(o.distributorLng)) {
        return {
          lat: Number(o.distributorLat),
          lng: Number(o.distributorLng),
        };
      }

      if (o.mapUrl) {
        const m = String(o.mapUrl).match(
          /(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/,
        );
        if (m) {
          return { lat: Number(m[1]), lng: Number(m[3]) };
        }
      }

      return { lat: null, lng: null };
    }

    /* --------------------------------------------------
       3️⃣ BUILD distributors[] FOR FULL ORDER
    -------------------------------------------------- */
    let distributors = [];

    // 🔹 3A: from FULL order (if already exists)
    const fullRes = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
      }),
    );

    if (Array.isArray(fullRes.Item?.distributors)) {
      distributors.push(...fullRes.Item.distributors);
    }

    // 🔹 3B: from CHILD orders
    for (const cid of childOrderIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
        }),
      );

      const o = g.Item;
      if (!o) continue;

      // CASE 1: already has distributors[]
      if (Array.isArray(o.distributors) && o.distributors.length > 0) {
        distributors.push(...o.distributors);
        continue;
      }

      // CASE 2: single-order shape → BUILD distributor
      if (o.distributorName) {
        const { lat, lng } = extractLatLng(o);
        if (!lat || !lng) continue; // ❗ SKIP invalid distributor

        distributors.push({
          distributorCode: o.distributorId || null,
          distributorName: o.distributorName,
          lat,
          lng,
          mapUrl: o.mapUrl || null,
          items: o.items || [],
          reachedAt: null,
          unloadStartAt: null,
          unloadEndAt: null,
        });
      }
    }

    /* --------------------------------------------------
       4️⃣ DEDUPE distributors
    -------------------------------------------------- */
    const seen = new Set();
    distributors = distributors.filter((d) => {
      const k = (d.distributorCode || d.distributorName || "")
        .toString()
        .trim()
        .toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!distributors.length) {
      return res.status(400).json({
        ok: false,
        message: "No valid distributor locations found",
      });
    }

    /* --------------------------------------------------
       5️⃣ Driver lookup
    -------------------------------------------------- */
    const driverPk = normalizeUserPk(driverId);
    const dg = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      }),
    );

    if (!dg.Item) {
      return res.status(404).json({
        ok: false,
        message: "Driver not found",
      });
    }

    const driverName = dg.Item.name || dg.Item.userName || "Driver";
    const driverMobile = dg.Item.mobile || null;

    /* --------------------------------------------------
       6️⃣ UPDATE FULL ORDER (🔥 FINAL FIX)
    -------------------------------------------------- */
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
        UpdateExpression: `
          SET #s = :st,
              driverId = :d,
              driverName = :dn,
              driverMobile = :dm,
              vehicleNo = :vn,
              distributors = :dist,
              currentDistributorIndex = :i
        `,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":st": "DRIVER_ASSIGNED",
          ":d": driverPk,
          ":dn": driverName,
          ":dm": driverMobile,
          ":vn": vehicleNo || null,
          ":dist": distributors,
          ":i": 0,
        },
      }),
    );

    /* --------------------------------------------------
       7️⃣ CHILD ORDERS → MERGED
    -------------------------------------------------- */
    for (const cid of childOrderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
          UpdateExpression:
            "SET #s = :st, mergedIntoOrderId = :mid REMOVE driverId, driverName, driverMobile",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "MERGED",
            ":mid": fullOrderId,
          },
        }),
      );
    }

    /* --------------------------------------------------
       8️⃣ Timeline (ONLY FULL)
    -------------------------------------------------- */
    const user = req.user || {};
    await addTimelineEvent({
      orderId: fullOrderId,
      event: "DRIVER_ASSIGNED",
      by: user.mobile || "system",
      byUserName: user.name || user.userName || null,
      role: user.role || "MANAGER",
      data: {
        flowKey: key,
        driverId: driverPk,
        driverName,
        driverMobile,
        vehicleNo: vehicleNo || null,
      },
    });

    return res.json({
      ok: true,
      message: "✅ Driver assigned successfully",
      fullOrderId,
      distributorCount: distributors.length,
    });
  } catch (err) {
    console.error("assignDriver error", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
};
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
