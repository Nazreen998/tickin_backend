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
