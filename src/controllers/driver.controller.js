import {
  getDriverOrders,
  updateDriverStatus,
  validateDriverReach30m,
} from "../services/driver.service.js";

export async function getOrders(req, res) {
  try {
    const { driverId } = req.params;
    if (!driverId) return res.status(400).json({ ok: false, message: "driverId required" });

    const orders = await getDriverOrders(String(driverId));
    return res.json({ ok: true, count: orders.length, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

export async function validateReach(req, res) {
  try {
    const { orderId } = req.params;
    const { currentLat, currentLng } = req.body || {};

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });
    if (currentLat == null || currentLng == null) {
      return res.status(400).json({ ok: false, message: "currentLat/currentLng required" });
    }

    const out = await validateDriverReach30m({
      orderId: String(orderId),
      currentLat: Number(currentLat),
      currentLng: Number(currentLng),
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message || String(e) });
  }
}

export async function updateStatus(req, res) {
  try {
    const { orderId } = req.params;
    const { nextStatus, currentLat, currentLng, force = false } = req.body || {};

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });
    if (!nextStatus) return res.status(400).json({ ok: false, message: "nextStatus required" });

    const updated = await updateDriverStatus({
      orderId: String(orderId),
      nextStatus: String(nextStatus).toUpperCase(),
      currentLat: currentLat == null ? null : Number(currentLat),
      currentLng: currentLng == null ? null : Number(currentLng),
      force: Boolean(force),
    });

    return res.json({ ok: true, order: updated });
  } catch (e) {
    // ConditionalCheckFailedException -> user double clicked or wrong sequence
    const msg = e?.name === "ConditionalCheckFailedException"
      ? "Invalid status update (already updated / wrong current status). Refresh and try again."
      : (e.message || String(e));

    return res.status(400).json({ ok: false, message: msg });
  }
}
