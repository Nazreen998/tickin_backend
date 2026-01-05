import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { addTimelineEvent } from "./timeline.helper.js";
import { ddb } from "../../config/dynamo.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getOrderTimeline } from "./timeline.service.js";

const router = express.Router();

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

      await addTimelineEvent({
        orderId,
        event: "LOAD_START",
        by: user.mobile,
        data: { role: user.role },   // ✅ fixed
      });

      return res.json({ message: "✅ LOAD_START added", orderId });
    } catch (err) {
      console.error("loading-start error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 2) VEHICLE SELECTED (Loading item scan)
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

      await addTimelineEvent({
        orderId,
        event: "VEHICLE_SELECTED", // ✅ changed to match timeline steps
        by: user.mobile,
        data: { role: user.role, productId, qty: Number(qty || 0) },
      });

      return res.json({ message: "✅ VEHICLE_SELECTED added", orderId, productId });
    } catch (err) {
      console.error("loading-item error:", err);
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

      await addTimelineEvent({
        orderId,
        event: "DRIVER_STARTED",
        by: user.mobile,
        data: { role: user.role },
      });

      return res.json({ message: "✅ DRIVER_STARTED added", orderId });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 3) LOADING END
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

      await addTimelineEvent({
        orderId,
        event: "LOAD_END",
        by: user.mobile,
        data: { role: user.role },
      });

      return res.json({ message: "✅ LOAD_END added", orderId });
    } catch (err) {
      console.error("loading-end error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 4) ASSIGN DRIVER
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

      await addTimelineEvent({
        orderId,
        event: "DRIVER_ASSIGNED",
        by: user.mobile,
        data: { role: user.role, driverId, vehicleNo },
      });

      await ddb.send(
        new UpdateCommand({
          TableName: "tickin_orders",
          Key: { pk: `ORDER#${orderId}`, sk: "META" },
          UpdateExpression:
            "SET driverId = :d, vehicleNo = :v, #st = :s, updatedAt = :t",
          ExpressionAttributeNames: {
            "#st": "status",
          },
          ExpressionAttributeValues: {
            ":d": String(driverId),
            ":v": vehicleNo || null,
            ":s": "DRIVER_ASSIGNED",
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({ message: "✅ DRIVER_ASSIGNED added", orderId, driverId });
    } catch (err) {
      console.error("assign-driver error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 5) ARRIVED
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

      const s = (stage || "DISTRIBUTOR").toUpperCase();
      const event =
        s === "WAREHOUSE" ? "WAREHOUSE_REACHED" : "DRIVER_REACHED_DISTRIBUTOR";

      await addTimelineEvent({
        orderId,
        event,
        by: user.mobile,
        data: { role: user.role, stage: s },
      });

      return res.json({ message: `✅ ${event} added`, orderId });
    } catch (err) {
      console.error("arrived error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 6) UNLOAD START
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

      await addTimelineEvent({
        orderId,
        event: "UNLOAD_START",
        by: user.mobile,
        data: { role: user.role },
      });

      return res.json({ message: "✅ UNLOAD_START added", orderId });
    } catch (err) {
      console.error("unload-start error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 7) UNLOAD END
=========================== */
router.post(
  "/unload-end",
  verifyToken,
  allowRoles("DRIVER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ message: "orderId required" });

      await addTimelineEvent({
        orderId,
        event: "UNLOAD_END",
        by: user.mobile,
        data: { role: user.role },
      });

      return res.json({ message: "✅ UNLOAD_END added", orderId });
    } catch (err) {
      console.error("unload-end error:", err);
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
