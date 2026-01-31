import {
  getDriverOrders,
  updateDriverStatus,
  validateDriverReach30m,
} from "../services/driver.service.js";
import { ddb } from "../config/dynamo.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb"; // ✅ ADD THIS

// small helper: accept both currentLat/currentLng OR driverLat/driverLng
function pickLatLng(body = {}) {
  const lat = body.currentLat ?? body.driverLat ?? body.lat ?? null;
  const lng = body.currentLng ?? body.driverLng ?? body.lng ?? null;

  const latN = lat == null ? null : Number(lat);
  const lngN = lng == null ? null : Number(lng);

  return {
    hasBoth: latN != null && lngN != null && Number.isFinite(latN) && Number.isFinite(lngN),
    lat: latN,
    lng: lngN,
  };
}

// status which needs location check
function needsLocation(nextStatus) {
  const s = String(nextStatus || "").toUpperCase();
  return ["DRIVER_REACHED_DISTRIBUTOR"].includes(s);
}

function normalizeErrMessage(e) {
  const msg = e?.message || String(e);

  if (msg.includes("Distributor location missing or invalid")) {
    return "Distributor location missing/invalid in DB. Order-ku distributors list/mapUrl set aaganum.";
  }
  if (msg.includes("Not allowed") || msg.includes("Access denied")) {
    return "Not allowed: indha endpoint role permission match aagala. Driver role-ku allow pannanum (backend RBAC).";
  }
  if (e?.name === "ConditionalCheckFailedException") {
    return "Invalid status update (already updated / wrong current status). Refresh and try again.";
  }
  return msg;
}

/* ------------------ APIs ------------------ */

export async function getOrders(req, res) {
  try {
    const { driverId } = req.params;
    if (!driverId) return res.status(400).json({ ok: false, message: "driverId required" });

    const orders = await getDriverOrders(String(driverId));
    return res.json({ ok: true, count: orders.length, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, message: normalizeErrMessage(e) });
  }
}

export async function validateReach(req, res) {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });

    const { hasBoth, lat, lng } = pickLatLng(req.body || {});
    if (!hasBoth) {
      return res.status(400).json({
        ok: false,
        message: "currentLat/currentLng required (or driverLat/driverLng).",
      });
    }

    const out = await validateDriverReach30m({
      orderId: String(orderId),
      currentLat: lat,
      currentLng: lng,
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(400).json({ ok: false, message: normalizeErrMessage(e) });
  }
}

export async function updateStatus(req, res) {
  try {
    const { orderId } = req.params;
    const body = req.body || {};
    const { nextStatus, force = false } = body;

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });
    if (!nextStatus) return res.status(400).json({ ok: false, message: "nextStatus required" });

    const statusUpper = String(nextStatus).toUpperCase();
    const { hasBoth, lat, lng } = pickLatLng(body);

    // if this status needs location, enforce lat/lng unless force=true
    if (!Boolean(force) && needsLocation(statusUpper) && !hasBoth) {
      return res.status(400).json({
        ok: false,
        message: `For nextStatus=${statusUpper}, currentLat/currentLng required (or driverLat/driverLng).`,
      });
    }

    // ✅ IMPORTANT: service already returns { ok:true/false, order: {...} } OR ok:false for Try again
    const result = await updateDriverStatus({
      orderId: String(orderId),
      nextStatus: statusUpper,
      currentLat: hasBoth ? lat : null,
      currentLng: hasBoth ? lng : null,
      force: Boolean(force),
    });

    return res.json(result);
  } catch (e) {
    return res.status(400).json({ ok: false, message: normalizeErrMessage(e) });
  }
}
export async function deleteDriverOrder(req, res) {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: "orderId required",
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: process.env.ORDERS_TABLE || "tickin_orders",
        Key: {
          pk: `ORDER#${orderId}`,
          sk: "META",
        },
        UpdateExpression:
          "SET deletedByDriver = :t, deletedAt = :dt",
        ExpressionAttributeValues: {
          ":t": true,
          ":dt": new Date().toISOString(),
        },
      })
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      message: e.message || "Delete failed",
    });
  }
}


