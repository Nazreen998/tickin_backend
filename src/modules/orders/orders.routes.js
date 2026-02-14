import express from "express";
import { ddb } from "../../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
} from "./orders.service.js";
import {
  vehicleSelected,
  loadingStart,
  loadingEnd,
  getOrderFlowByKey,
   assignDriver,
  getDriversForDropdown,
  slotCompleted, 
} from "./orders.flow.service.js";

import { fixDistributors } from "./orders.controller.js";
const router = express.Router();
router.post(
  "/slot-completed",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  slotCompleted
);

router.post("/fix-distributors", fixDistributors);
router.get("/distributors/:code", async (req, res) => {
  try {
    const code = req.params.code;
    const out = await ddb.send(
      new GetCommand({
        TableName: "tickin_distributors",
        Key: { pk: "DISTRIBUTOR", sk: code },
      })
    );
    if (!out.Item) return res.status(404).json({ ok: false, message: "Not found" });
    return res.json({ ok: true, item: out.Item });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

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

// ✅ Sales Officer / Salesman / Distributor / Manager - My Orders
router.get(
  "/my",
  verifyToken,
  allowRoles(
    "SALES OFFICER",
    "SALESMAN",
    "DISTRIBUTOR",
    "SALES OFFICER VNR",
    "SALES_OFFICER_VNR",
    "MANAGER"
  ),
  async (req, res) => {
    try {
      const user = req.user;
      const status = req.query.status; // 👈 same as /all
      const date = req.query.date;     // 👈 optional

      let distributorCodes = [];

      // DISTRIBUTOR → own orders
      if (user.role === "DISTRIBUTOR") {
        const code = String(
          user.distributorCode || user.distributorId || ""
        ).trim();
        if (code) distributorCodes = [code];
      }
      // SALES / MANAGER → mapped distributors
      else {
        distributorCodes = Array.isArray(user.allowedDistributors)
          ? user.allowedDistributors
          : [];
      }

      if (distributorCodes.length === 0) {
        return res.json({ ok: true, count: 0, orders: [] });
      }

      const data = await getOrdersForSalesman({
        distributorCodes,
        status, // 👈 OPTIONAL (CONFIRMED / DELIVERY_COMPLETED / etc.)
        date,   // 👈 OPTIONAL (yyyy-MM-dd)
      });

      return res.json({
        ok: true,
        distributorCodes,
        ...data,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: err.message,
      });
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
      const { status, date } = req.query; // ✅ take both

      const data = await getAllOrders({ status, date }); // ✅ pass both

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

// ✅ NEW (flow based)
router.post(
  "/vehicle-selected/:flowKey",
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
router.post("/force-reset/:orderId", async (req, res) => {
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
const visibleOrders = (orders || []).filter((o) => {
  // ❌ hide child orders of merged flow
  if (o.mergedIntoOrderId && !String(o.orderId).startsWith("ORD_FULL_")) {
    return false;
  }

  // ❌ hide driver-deleted orders
  if (o.deletedByDriver === true) return false;

  return true;
});

    return res.json({
      ok: true,
      count: visibleOrders.length,
      orders: visibleOrders,
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
