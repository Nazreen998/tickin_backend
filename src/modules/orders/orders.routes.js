import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { forceResetOrderSlotMeta } from "./orders.service.js"; // ✅ ADD THIS
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
  confirmDraftOrder,
  deleteOrder,
  cancelOrderSlot,
  getOrdersByMergeKey,
  getSlotConfirmedOrders,
  getAssignedOrdersByDriver
} from "./orders.service.js";

import {
  vehicleSelected,
  loadingStart,
  loadingEnd,
  getOrderFlowByKey,
   assignDriver,
  getDriversForDropdown, 
} from "./orders.flow.service.js";

const router = express.Router();
router.get(
  "/drivers",
  verifyToken,
  allowRoles("MANAGER"),
  getDriversForDropdown
);
router.get("/driver-list", verifyToken, allowRoles("MANAGER","MASTER"), getDriversForDropdown);
router.get("/drivers/list", verifyToken, allowRoles("MANAGER","MASTER"), getDriversForDropdown);

/* ===========================
   MASTER / MANAGER ROUTES
=========================== */

// ✅ Slot confirmed orders (Manager only flow)
router.get(
  "/slot-confirmed",
  verifyToken,
  allowRoles("MANAGER"),
  getSlotConfirmedOrders
);

// ✅ MASTER pending orders
router.get(
  "/pending",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  getPendingOrders
);

// ✅ delete order
router.delete("/:orderId", verifyToken, deleteOrder);
router.post(
  "/vehicle-selected/:flowKey",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  vehicleSelected
);

router.get(
  "/merge/:mergeKey",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  getOrdersByMergeKey
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

// ✅ Confirm order + slot booking (Manager / Sales Officer only)
router.post(
  "/confirm/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "MANAGER","SALES OFFICER VNR","SALES_OFFICER_VNR"),
  confirmOrder
);

/* ===========================
   SALESMAN / SALES OFFICER ROUTES
=========================== */

// ✅ Create order as DRAFT ✅ (SALESMAN added)
router.post(
  "/create",
  verifyToken,
  allowRoles("MANAGER", "SALES OFFICER", "SALES OFFICER VNR", "SALESMAN","SALES_OFFICER_VNR"),
  createOrder
);

// ✅ Update order items ✅ (SALESMAN added)
router.patch(
  "/update/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "MANAGER", "SALES OFFICER VNR","SALES_OFFICER_VNR", "SALESMAN"),
  updateOrderItems
);

// ✅ Confirm draft order ✅ (SALESMAN added)
router.post(
  "/confirm-draft/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "SALESMAN", "SALES OFFICER VNR","SALES_OFFICER_VNR"),
  confirmDraftOrder
);

// ✅ Sales Officer / Salesman view all assigned distributor orders (CONFIRMED)
router.get(
  "/my",
  verifyToken,
  allowRoles("SALES OFFICER", "SALESMAN", "DISTRIBUTOR", "SALES OFFICER VNR","MANAGER","SALES_OFFICER_VNR" ),
  async (req, res) => {
    try {
      const user = req.user;

      const allowed = Array.isArray(user.allowedDistributors)
        ? user.allowedDistributors
        : [];

      const one = String(user.distributorCode || user.distributorId || "").trim();
      const distributorCodes = allowed.length > 0 ? allowed : (one ? [one] : []);

      if (distributorCodes.length === 0) {
        return res.json({
          ok: true,
          count: 0,
          distributorCodes: [],
          orders: [],
        });
      }

      const data = await getOrdersForSalesman({
        distributorCodes,
        status: "CONFIRMED",
      });

      return res.json({
        ok: true,
        distributorCodes,
        ...data,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);
router.post(
  "/force-reset/:orderId",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const out = await forceResetOrderSlotMeta(orderId);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
);
// ✅ Manager / Master view all orders
router.get(
  "/all",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const status = req.query.status;
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

// ✅ View order by ID ✅ (SALESMAN added)
router.get(
  "/:orderId",
  verifyToken,
  allowRoles("SALES OFFICER", "SALESMAN", "DISTRIBUTOR", "MANAGER", "SALES OFFICER VNR","SALES_OFFICER_VNR"),
  getOrderById
);

/* ==========================
   ✅ ORDER FLOW (AFTER SLOT)
========================== */

// ✅ Vehicle selected
router.post(
  "/vehicle-selected/:orderId",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  vehicleSelected
);

// ✅ Loading start
router.post(
  "/loading-start",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  loadingStart
);

// ✅ Loading end
router.post(
  "/loading-end",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  loadingEnd
);
router.post("/orders/force-reset/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const out = await forceResetOrderSlotMeta(orderId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.patch("/:orderId/cancel-slot", verifyToken, cancelOrderSlot);
// ✅ Assign Driver
router.post(
  "/assign-driver",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  assignDriver
);
router.get(
  "/flow/:flowKey",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  getOrderFlowByKey
);
/* ===========================
   DRIVER ORDERS 
=========================== */
const getDriverAssignedOrders = async (req, res) => {
  try {
    const user = req.user;

    if (!user || String(user.role).toUpperCase() !== "DRIVER") {
      return res.status(403).json({
        ok: false,
        message: "Only drivers can access this",
      });
    }

    const driverId =
      user.pk ||
      (user.mobile ? `USER#${user.mobile}` : null);

    if (!driverId) {
      return res.status(400).json({
        ok: false,
        message: "Driver identity not found",
      });
    }

    const orders = await getAssignedOrdersByDriver(driverId);

    return res.json({
      ok: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
};

router.get(
  "/driver/assigned",
  verifyToken,
  getDriverAssignedOrders
);
export default router;
