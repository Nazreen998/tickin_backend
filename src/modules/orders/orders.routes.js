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
  getOrdersForSalesman,
  getAllOrders,
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
  allowRoles("SALES OFFICER", "MANAGER"),
  confirmOrder
);


/* ===========================
   SALESMAN ROUTES
=========================== */

// ✅ Create order as DRAFT
router.post(
  "/create",
  verifyToken,
  allowRoles("MANAGER","SALES OFFICER"),
  createOrder
);

// ✅ Salesman update order items (Edit/Add/Remove)
router.patch(
  "/update/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "MANAGER", "MASTER"),
  updateOrderItems
);

// ✅ Confirm draft order (DRAFT → PENDING)
router.post(
  "/confirm-draft/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER"),
  confirmDraftOrder
);

// ✅ Sales Officer view all assigned distributor orders (DRAFT/PENDING/CONFIRMED)
router.get(
  "/my",
  verifyToken,
  allowRoles("SALES OFFICER"),
  async (req, res) => {
    try {
      const user = req.user;
      const location = String(user.location || user.Location || "").trim();

      if (!location) {
        return res.status(400).json({
          ok: false,
          message: "Salesman location missing in token",
        });
      }

      // ✅ call service
      const data = await getOrdersForSalesman({ location });

      return res.json({
        ok: true,
        salesmanLocation: location,
        ...data,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

// ✅ Manager / Master view all orders (all distributors, all status)
router.get(
  "/all",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const status = req.query.status; // optional filter
      const data = await getAllOrders({ status });
      return res.json({ ok: true, ...data });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
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
