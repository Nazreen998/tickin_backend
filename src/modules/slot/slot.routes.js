import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
  managerSetSlotMaxAmount,   // ✅ NEW
} from "./slot.service.js";

const router = express.Router();

/**
 * ✅ GET SLOT GRID
 * URL: /api/slots?companyCode=ABC&date=2025-12-27
 * ✅ MASTER / MANAGER / SALES OFFICER / DISTRIBUTOR can view
 */
router.get(
  "/slots",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR"),
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
 * ✅ Manager Open Last Slot
 * URL: /api/slots/open-last
 * ✅ Only MANAGER
 */
router.post(
  "/slots/open-last",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.body;
      if (!companyCode || !date) {
        return res.status(400).json({ ok: false, error: "companyCode & date required" });
      }

      const data = await managerOpenLastSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Manager Set Slot MaxAmount (80k override)
 * URL: /api/slots/set-max
 * ✅ Only MANAGER
 */
router.post(
  "/slots/set-max",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, location, maxAmount } = req.body;

      if (!companyCode || !date || !time || !location || !maxAmount) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,location,maxAmount required",
        });
      }

      const out = await managerSetSlotMaxAmount({
        companyCode,
        date,
        time,
        location,
        maxAmount: Number(maxAmount),
      });

      return res.json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Book Slot
 * URL: /api/slots/book
 * ✅ MANAGER can book
 * ✅ SALES OFFICER can book
 */
router.post(
  "/slots/book",
  verifyToken,
  allowRoles("MANAGER", "SALES OFFICER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, distributorCode, amount } = req.body;

      if (!companyCode || !date || !time || !vehicleType || !pos || !distributorCode) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,vehicleType,pos,distributorCode required",
        });
      }

      // ✅ take userId from JWT token
      const userId = req.user?.userId || req.user?.id;
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Invalid token userId" });
      }

      const data = await bookSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        distributorCode,
        userId,
        amount: Number(amount || 0), // ✅ optional now; later fetch from order
      });

      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Cancel Slot
 * URL: /api/slots/cancel
 * ✅ Only MANAGER can cancel (as per your final rule)
 */
router.post(
  "/slots/cancel",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, targetUserId } = req.body;

      if (!companyCode || !date || !time || !vehicleType || !pos) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,vehicleType,pos required",
        });
      }

      // ✅ manager can cancel anyone by passing targetUserId
      const userId = targetUserId || req.user?.userId || req.user?.id;
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Invalid token userId" });
      }

      const data = await cancelSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        userId,
      });

      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Join Waiting Queue
 * URL: /api/slots/waiting
 * ✅ Only MANAGER + SALES OFFICER
 */
router.post(
  "/slots/waiting",
  verifyToken,
  allowRoles("MANAGER", "SALES OFFICER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, distributorCode } = req.body;

      if (!companyCode || !date || !time || !distributorCode) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,distributorCode required",
        });
      }

      const userId = req.user?.userId || req.user?.id;
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Invalid token userId" });
      }

      const data = await joinWaiting({
        companyCode,
        date,
        time,
        vehicleType: vehicleType || "HALF",
        distributorCode,
        userId,
      });

      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
