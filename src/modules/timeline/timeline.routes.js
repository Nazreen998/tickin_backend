import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { addTimelineEvent } from "./timeline.helper.js";
import { ddb } from "../../config/dynamo.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getOrderTimeline } from "./timeline.service.js";

const router = express.Router();

/* ===========================
   ✅ OPTIONAL: Update order status helper
=========================== */
const updateOrderStatus = async (orderId, status) => {
  if (!status) return;
  await ddb.send(
    new UpdateCommand({
      TableName: "tickin_orders",
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression: "SET #st = :s, updatedAt = :t",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":t": new Date().toISOString(),
      },
    })
  );
};

/* ===========================
   ✅ 1) LOADING START
   POST /timeline/loading-start
   Roles: MASTER / MANAGER
   Body: { orderId }
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
        extra: { role: user.role },
      });

      // optional order status update
      // await updateOrderStatus(orderId, "LOAD_START");

      return res.json({ message: "✅ LOAD_START added", orderId });
    } catch (err) {
      console.error("loading-start error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 2) LOADING ITEM (each item scan)
   POST /timeline/loading-item
   Roles: MASTER / MANAGER
   Body: { orderId, productId, qty }
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
        event: "VEHICLE_SELECTED", // ✅ you said flow has VEHICLE_SELECTED; if you want "LOADING_ITEM" tell me
        by: user.mobile,
        extra: { role: user.role, productId, qty: Number(qty || 0) },
      });

      return res.json({ message: "✅ LOADING_ITEM added", orderId, productId });
    } catch (err) {
      console.error("loading-item error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 3) LOADING END
   POST /timeline/loading-end
   Roles: MASTER / MANAGER
   Body: { orderId }
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
        extra: { role: user.role },
      });

      // optional
      // await updateOrderStatus(orderId, "LOAD_END");

      return res.json({ message: "✅ LOAD_END added", orderId });
    } catch (err) {
      console.error("loading-end error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 4) ASSIGN DRIVER
   POST /timeline/assign-driver
   Roles: MASTER / MANAGER
   Body: { orderId, driverId, vehicleNo? }
=========================== */
router.post(
  "/assign-driver",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
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
        extra: { role: user.role, driverId, vehicleNo },
      });

      // optional
      // await updateOrderStatus(orderId, "DRIVER_ASSIGNED");

      return res.json({ message: "✅ DRIVER_ASSIGNED added", orderId, driverId });
    } catch (err) {
      console.error("assign-driver error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ 5) ARRIVED (driver reached distributor / warehouse etc)
   POST /timeline/arrived
   Roles: DRIVER
   Body: { orderId, stage }
   stage can be: "DISTRIBUTOR" | "WAREHOUSE"
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

      // default distributor arrival
      const s = (stage || "DISTRIBUTOR").toUpperCase();

      const event =
        s === "WAREHOUSE" ? "WAREHOUSE_REACHED" : "DRIVER_REACHED_DISTRIBUTOR";

      await addTimelineEvent({
        orderId,
        event,
        by: user.mobile,
        extra: { role: user.role, stage: s },
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
   POST /timeline/unload-start
   Roles: DRIVER
   Body: { orderId }
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
        extra: { role: user.role },
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
   POST /timeline/unload-end
   Roles: DRIVER
   Body: { orderId }
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
        extra: { role: user.role },
      });

      // optional
      // await updateOrderStatus(orderId, "DELIVERED");

      return res.json({ message: "✅ UNLOAD_END added", orderId });
    } catch (err) {
      console.error("unload-end error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/* ===========================
   ✅ GET Timeline (already)
   GET /timeline/:orderId
   Roles: MASTER / MANAGER / DISTRIBUTOR / SALES OFFICER / DRIVER
=========================== */
router.get(
  "/:orderId",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "DISTRIBUTOR", "SALES OFFICER", "DRIVER"),
  getOrderTimeline
);

export default router;
