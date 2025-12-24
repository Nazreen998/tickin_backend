import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getPendingOrders,
  getTodayOrders,
  getDeliveryOrders,
  createOrder,
  updatePendingReason,
  confirmOrder,
  updateOrderItems,
  getOrderById,
  confirmDraftOrder
} from "./orders.service.js";

const router = express.Router();

/* ===========================
   MASTER / MANAGER ROUTES
=========================== */

// ✅ MASTER pending orders
router.get(
  "/pending",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  getPendingOrders
);

// ✅ MASTER today orders
router.get(
  "/today",
  verifyToken,
  allowRoles("MASTER"),
  getTodayOrders
);

// ✅ MASTER delivery orders
router.get(
  "/delivery",
  verifyToken,
  allowRoles("MASTER"),
  getDeliveryOrders
);

// ✅ Manager update reason
router.patch(
  "/:orderId/reason",
  verifyToken,
  allowRoles("MANAGER"),
  updatePendingReason
);

// ✅ Confirm order + slot booking (Manager / Master only)
router.post(
  "/confirm/:orderId",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  confirmOrder
);


/* ===========================
   SALESMAN ROUTES
=========================== */

// ✅ Create order as DRAFT
router.post(
  "/create",
  verifyToken,
  allowRoles("SALES OFFICER"),
  createOrder
);

// ✅ Salesman update order items (Edit/Add/Remove)
router.patch(
  "/update/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER"),
  updateOrderItems
);

// ✅ Confirm draft order (DRAFT → PENDING)
router.post(
  "/confirm-draft/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER"),
  confirmDraftOrder
);


/* ===========================
   VIEW ORDER ROUTE
=========================== */

// ✅ Get order details (Salesman, Distributor, Manager, Master)
router.get(
  "/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "DISTRIBUTOR", "MANAGER", "MASTER"),
  getOrderById
);

export default router;
