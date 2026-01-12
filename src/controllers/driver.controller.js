import {
  getDriverOrders,
  updateDriverStatus,
  validateDriverReach30m,
} from "../services/driver.service.js";

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

// optional: status which needs location check (customize as per your flow)
function needsLocation(nextStatus) {
  const s = String(nextStatus || "").toUpperCase();
  // add/remove statuses as your backend expects
  return ["REACHED", "ARRIVED", "DELIVERED"].includes(s);
}

function normalizeErrMessage(e) {
  const msg = e?.message || String(e);

  // map common errors to user friendly messages
  if (msg.includes("Distributor location missing or invalid")) {
    return "Distributor location missing/invalid in DB. Order-ku distributorLat/distributorLng save pannunga (final_url mattum podadheenga).";
  }
  if (msg.includes("Not allowed") || msg.includes("Access denied")) {
    return "Not allowed: indha endpoint role permission match aagala. Driver role-ku allow pannanum (backend RBAC).";
  }
  if (e?.name === "ConditionalCheckFailedException") {
    return "Invalid status update (already updated / wrong current status). Refresh and try again.";
  }
  return msg;
}

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

    // NOTE: function name says 30m; if you want 50km, change in service side
    const out = await validateDriverReach30m({
      orderId: String(orderId),
      currentLat: lat,
      currentLng: lng,
    });

    // out can be { reached: true/false, distanceKm, ... } depending on service
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
    if (!force && needsLocation(statusUpper) && !hasBoth) {
      return res.status(400).json({
        ok: false,
        message: `For nextStatus=${statusUpper}, currentLat/currentLng required (or driverLat/driverLng).`,
      });
    }

    const updated = await updateDriverStatus({
      orderId: String(orderId),
      nextStatus: statusUpper,
      currentLat: hasBoth ? lat : null,
      currentLng: hasBoth ? lng : null,
      force: Boolean(force),
    });

    return res.json({ ok: true, order: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: normalizeErrMessage(e) });
  }
}
