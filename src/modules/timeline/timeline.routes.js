import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { addTimelineEvent } from "./timeline.helper.js";
import { ddb } from "../../config/dynamo.js";
import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
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

  if (order.mergedIntoOrderId) {
    return String(order.mergedIntoOrderId);
  }

  return orderId;
}

/* ===========================
   ✅ 1) LOADING START
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
        orderId: trackingOrderId, // ✅ FIXED
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
   ✅ 2) LOADING ITEM (scan items)
   event = LOADING_ITEM
=========================== */
router.post(
  "/loading-item",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, productId, qty, productName } = req.body;

      if (!orderId) return res.status(400).json({ message: "orderId required" });
      if (!productId) return res.status(400).json({ message: "productId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOADING_ITEM",
        by: user.mobile,
        role: user.role,
        data: {
          productId,
          productName: productName || null,
          qty: Number(qty || 0),
          originalOrderId: orderId,
        },
      });

      return res.json({
        ok: true,
        message: "✅ LOADING_ITEM added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 3) VEHICLE SELECTED (NEW)
=========================== */
router.post(
  "/vehicle-selected",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, vehicleNo } = req.body;

      if (!orderId) return res.status(400).json({ message: "orderId required" });
      if (!vehicleNo) return res.status(400).json({ message: "vehicleNo required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "VEHICLE_SELECTED",
        by: user.mobile,
        role: user.role,
        data: { vehicleNo, originalOrderId: orderId },
      });

      // ✅ Update order meta also
      await ddb.send(
        new UpdateCommand({
          TableName: "tickin_orders",
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression: "SET vehicleNo=:v, updatedAt=:t",
          ExpressionAttributeValues: {
            ":v": vehicleNo,
            ":t": new Date().toISOString(),
          },
        })
      );

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
   ✅ 4) LOADING END
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

      return res.json({
        ok: true,
        message: "✅ LOAD_END added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 5) ASSIGN DRIVER
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
   ✅ 6) DRIVER STARTED
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

      return res.json({
        ok: true,
        message: "✅ DRIVER_STARTED added",
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 7) ARRIVED (D1 / D2 / WAREHOUSE)
   body: { orderId, stage, distributorCode? }
=========================== */
router.post(
  "/arrived",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, stage, distributorCode } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      const s = (stage || "DISTRIBUTOR").toUpperCase();
      const event = s === "WAREHOUSE"
        ? "WAREHOUSE_REACHED"
        : "DRIVER_REACHED_DISTRIBUTOR";

      await addTimelineEvent({
        orderId: trackingOrderId,
        event,
        by: user.mobile,
        role: user.role,
        data: {
          stage: s, // ✅ D1 / D2 / WAREHOUSE
          distributorCode: distributorCode || null,
          originalOrderId: orderId,
        },
      });

      return res.json({
        ok: true,
        message: `✅ ${event} added`,
        orderId,
        trackingOrderId,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 8) UNLOAD START / END (D1 / D2)
   body: { orderId, stage }
=========================== */
router.post(
  "/unload-start",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, stage, distributorCode } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "UNLOAD_START",
        by: user.mobile,
        role: user.role,
        data: {
          stage: (stage || "D1").toUpperCase(),
          distributorCode: distributorCode || null,
          originalOrderId: orderId,
        },
      });

      return res.json({
        ok: true,
        message: "✅ UNLOAD_START added",
        orderId,
        trackingOrderId,
      });
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
      const { orderId, stage, distributorCode } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "UNLOAD_END",
        by: user.mobile,
        role: user.role,
        data: {
          stage: (stage || "D1").toUpperCase(),
          distributorCode: distributorCode || null,
          originalOrderId: orderId,
        },
      });

      return res.json({
        ok: true,
        message: "✅ UNLOAD_END added",
        orderId,
        trackingOrderId,
      });
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
