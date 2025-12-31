import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  managerSetSlotMaxAmount,
  managerAssignCluster,
  managerConfirmHalfTrip,
} from "./slot.service.js";

const router = express.Router();

/**
 * ✅ GET SLOT GRID
 */
router.get(
  "/slots",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;
      if (!companyCode || !date) {
        return res.status(400).json({ ok: false, error: "companyCode & date required" });
      }

      const data = await getSlotGrid({ companyCode, date });
      return res.json({ ok: true, slots: data });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ BOOK SLOT
 */
router.post(
  "/slots/book",
  verifyToken,
  allowRoles("MANAGER", "MASTER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const { companyCode, date, time, pos, distributorCode, amount, orderId } = req.body;

      if (!companyCode || !date || !time || !distributorCode) {
        return res.status(400).json({ ok: false, error: "companyCode,date,time,distributorCode required" });
      }

      const userId = req.user?.pk || req.user?.mobile || req.user?.userId || req.user?.id;
      if (!userId) return res.status(401).json({ ok: false, error: "Invalid token userId" });

      const out = await bookSlot({
        companyCode,
        date,
        time,
        pos,
        distributorCode,
        userId,
        amount: Number(amount || 0),
        orderId,
      });

      return res.json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ MANAGER CONFIRM HALF MERGE
 * FULL_PENDING → FULL_CONFIRMED
 */
router.post(
  "/slots/half/confirm",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, mergeKey } = req.body;

      if (!companyCode || !date || !time || !mergeKey) {
        return res.status(400).json({ ok: false, error: "companyCode,date,time,mergeKey required" });
      }

      const out = await managerConfirmHalfTrip({ companyCode, date, time, mergeKey });
      return res.json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ CANCEL SLOT (FULL ONLY)
 */
router.post(
  "/slots/cancel",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, targetUserId, orderId } = req.body;

      if (!companyCode || !date || !time || !vehicleType) {
        return res.status(400).json({ ok: false, error: "companyCode,date,time,vehicleType required" });
      }

      if (vehicleType === "FULL" && !pos) {
        return res.status(400).json({ ok: false, error: "pos required for FULL cancel" });
      }

      const userId = targetUserId || req.user?.pk || req.user?.mobile;
      if (!userId) return res.status(401).json({ ok: false, error: "Invalid token userId" });

      const out = await cancelSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        userId,
        orderId,
      });

      return res.json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
