import express from "express";
import { updateStatus, getOrders } from "../controllers/driver.controller.js";

const router = express.Router();

// ✅ driver card list
router.get("/:driverId/orders", getOrders);

// ✅ sequential status update
router.post("/order/:orderId/status", updateStatus);

export default router;
