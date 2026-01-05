import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { addTimelineEvent } from "./timeline.helper.js";
import { ddb } from "../../config/dynamo.js";
import { UpdateCommand, GetCommand, } from "@aws-sdk/lib-dynamodb";
import { getOrderTimeline } from "./timeline.service.js";

const router = express.Router();

/* ===========================
   ✅ helper: resolve tracking orderId
   If HALF order merged -> return FULL orderId
=========================== */
async function resolveTrackingOrderId(orderId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: "tickin_orders",
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  const order = res.Item;
  if (!order) return orderId;

  // ✅ if this order is merged into FULL order
  if (order.mergedIntoOrderId) {
    return String(order.mergedIntoOrderId);
  }

  return orderId;
}

/* ===========================
   ✅ LOADING START
=========================== */
router.post(
  "/loading-start",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOAD_START",
        by: user.mobile,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      return res.json({
        ok: true,
        message: "✅ LOAD_START added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ LOADING ITEM
=========================== */
router.post(
  "/loading-item",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, productId, qty } = req.body;

      if (!orderId) return res.status(400).json({ message: "orderId required" });
      if (!productId) return res.status(400).json({ message: "productId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "VEHICLE_SELECTED",
        by: user.mobile,
        role: user.role,
        data: {
          productId,
          qty: Number(qty || 0),
          originalOrderId: orderId,
        },
      });

      return res.json({
        ok: true,
        message: "✅ VEHICLE_SELECTED added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ LOADING END
=========================== */
router.post(
  "/loading-end",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOAD_END",
        by: user.mobile,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      return res.json({ ok: true, message: "✅ LOAD_END added", orderId, trackingOrderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ ASSIGN DRIVER
=========================== */
router.post(
  "/assign-driver",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, driverId, vehicleNo } = req.body;

      if (!orderId) return res.status(400).json({ message: "orderId required" });
      if (!driverId) return res.status(400).json({ message: "driverId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "DRIVER_ASSIGNED",
        by: user.mobile,
        role: user.role,
        data: { driverId, vehicleNo, originalOrderId: orderId },
      });

      // ✅ update FULL order META (so driver dashboard shows correct)
      await ddb.send(
        new UpdateCommand({
          TableName: "tickin_orders",
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression: "SET driverId=:d, vehicleNo=:v, #st=:s, updatedAt=:t",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":d": String(driverId),
            ":v": vehicleNo || null,
            ":s": "DRIVER_ASSIGNED",
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({
        ok: true,
        message: "✅ DRIVER_ASSIGNED added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ DRIVER STARTED
=========================== */
router.post(
  "/driver-started",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "DRIVER_STARTED",
        by: user.mobile,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      return res.json({ ok: true, message: "✅ DRIVER_STARTED added", orderId, trackingOrderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ ARRIVED
=========================== */
router.post(
  "/arrived",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, stage } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      const s = (stage || "DISTRIBUTOR").toUpperCase();
      const event = s === "WAREHOUSE" ? "WAREHOUSE_REACHED" : "DRIVER_REACHED_DISTRIBUTOR";

      await addTimelineEvent({
        orderId: trackingOrderId,
        event,
        by: user.mobile,
        role: user.role,
        data: { stage: s, originalOrderId: orderId },
      });

      return res.json({ ok: true, message: `✅ ${event} added`, orderId, trackingOrderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ UNLOAD START / END
=========================== */
router.post(
  "/unload-start",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "UNLOAD_START",
        by: user.mobile,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      return res.json({ ok: true, message: "✅ UNLOAD_START added", orderId, trackingOrderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

router.post(
  "/unload-end",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "UNLOAD_END",
        by: user.mobile,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      return res.json({ ok: true, message: "✅ UNLOAD_END added", orderId, trackingOrderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ GET Timeline
=========================== */
router.get(
  "/:orderId",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "DISTRIBUTOR", "SALES OFFICER", "DRIVER"),
  getOrderTimeline
);

export default router;
