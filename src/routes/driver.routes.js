import express from "express";
import {
  updateStatus,
  getOrders,
  deleteDriverOrder,
  validateReach,
} from "../controllers/driver.controller.js";

const router = express.Router();

// ✅ driver card list
router.get("/:driverId/orders", getOrders);

// ✅ 30m reach validation (optional but recommended)
router.post("/order/:orderId/validate-reach", validateReach);

// ✅ sequential status update
router.post("/order/:orderId/status", updateStatus);

// driver deletes order from his list
router.post("/order/:orderId/delete", deleteDriverOrder);

export default router;
