import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import { addTimelineEvent } from "./timeline.helper.js";
import {
  getOrderTimeline,
  getSlotTimeline,
  getOrderTimelineNeat,
  getSlotTimelineNeat,
} from "./timeline.service.js";

import { ddb } from "../../config/dynamo.js";
import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const router = express.Router();

const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

/* ✅ helper: resolve tracking orderId */
async function resolveTrackingOrderId(orderId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  const order = res.Item;
  if (!order) return orderId;

  if (order.mergedIntoOrderId) return String(order.mergedIntoOrderId);

  return orderId;
}

/* ✅ 1) LOADING START */
router.post(
  "/loading-start",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId)
        return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOAD_START",
        by: user.mobile,
        byUserName: user?.name || user?.userName || null,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      // ✅ UPDATE ORDER STATUS ALSO
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression: "SET #st=:s, updatedAt=:t",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":s": "LOADING_STARTED",
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({ ok: true, trackingOrderId });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);

/* ✅ 2) LOADING ITEM */
router.post(
  "/loading-item",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId, productId, qty, productName } = req.body;

      if (!orderId)
        return res.status(400).json({ message: "orderId required" });
      if (!productId)
        return res.status(400).json({ message: "productId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOADING_ITEM",
        by: user.mobile,
        byUserName: user?.name || user?.userName || null,
        role: user.role,
        data: {
          productId,
          productName: productName || null,
          qty: Number(qty || 0),
          originalOrderId: orderId,
        },
      });

      return res.json({ ok: true, trackingOrderId });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);

/* ✅ 3) VEHICLE SELECTED */
router.post(
  "/vehicle-selected",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const { orderId, vehicleNo, vehicleType } = req.body;

      if (!orderId)
        return res.status(400).json({ message: "orderId required" });
      if (!vehicleNo)
        return res.status(400).json({ message: "vehicleNo required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "VEHICLE_SELECTED",
        by: req.user?.mobile || "system",
        byUserName: req.user?.name || req.user?.userName || null,
        role: req.user?.role || "MANAGER",
        data: {
          vehicleNo: vehicleNo || null,
          vehicleType: vehicleType || null,
          originalOrderId: orderId,
        },
      });

      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression: "SET vehicleNo=:v, updatedAt=:t",
          ExpressionAttributeValues: {
            ":v": vehicleNo,
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({ ok: true, trackingOrderId });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);

/* ✅ 4) LOADING END */
router.post(
  "/loading-end",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const user = req.user;
      const { orderId } = req.body;
      if (!orderId)
        return res.status(400).json({ message: "orderId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "LOAD_END",
        by: user.mobile,
        byUserName: user?.name || user?.userName || null,
        role: user.role,
        data: { originalOrderId: orderId },
      });

      // ✅ UPDATE ORDER STATUS ALSO
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression: "SET #st=:s, updatedAt=:t",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":s": "LOADING_COMPLETED",
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({ ok: true, trackingOrderId });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);

/* ✅ 5) ASSIGN DRIVER */
router.post(
  "/assign-driver",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  async (req, res) => {
    try {
      const { orderId, driverId, vehicleNo } = req.body;

      if (!orderId)
        return res.status(400).json({ message: "orderId required" });
      if (!driverId)
        return res.status(400).json({ message: "driverId required" });

      const trackingOrderId = await resolveTrackingOrderId(orderId);

      await addTimelineEvent({
        orderId: trackingOrderId,
        event: "DRIVER_ASSIGNED",
        by: req.user?.mobile || "system",
        byUserName: req.user?.name || req.user?.userName || null,
        role: req.user?.role || "MANAGER",
        // ✅ fixed undefined variables (driverPk/driver.name removed)
        data: { driverId: String(driverId), driverName: null, vehicleNo: vehicleNo || null },
      });

      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${trackingOrderId}`, sk: "META" },
          UpdateExpression:
            "SET driverId=:d, vehicleNo=:v, #st=:s, updatedAt=:t",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":d": String(driverId),
            ":v": vehicleNo || null,
            ":s": "DRIVER_ASSIGNED",
            ":t": new Date().toISOString(),
          },
        })
      );

      return res.json({ ok: true, trackingOrderId });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);

/* ✅ IMPORTANT: SLOT routes must come BEFORE /:orderId routes */

/* ✅ GET Slot Timeline (raw + neat) */
router.get(
  "/slot/:slotId",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  getSlotTimeline
);

/* ✅ GET Slot Timeline (NEAT ONLY) */
router.get(
  "/slot/:slotId/neat",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  getSlotTimelineNeat
);

/* ✅ GET Order Timeline (raw + neat) */
router.get(
  "/:orderId",
  verifyToken,
  allowRoles(
    "MASTER",
    "MANAGER",
    "DISTRIBUTOR",
    "SALES OFFICER",
    "SALES_OFFICER_VNR",
    "SALES OFFICER VNR",
    "DRIVER",
    "SALESMAN"
  ),
  getOrderTimeline
);

/* ✅ GET Order Timeline (NEAT ONLY) */
router.get(
  "/:orderId/neat",
  verifyToken,
  allowRoles(
    "MASTER",
    "MANAGER",
    "DISTRIBUTOR",
    "SALES OFFICER",
    "SALES_OFFICER_VNR",
    "SALES OFFICER VNR",
    "DRIVER",
    "SALESMAN"
  ),
  getOrderTimelineNeat
);

export default router;
