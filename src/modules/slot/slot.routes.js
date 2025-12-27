import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
} from "./slot.service.js";

const router = express.Router();

/**
 * ✅ GET SLOT GRID
 * URL: /api/slots?companyCode=ABC&date=2025-12-27
 * ✅ Everyone can view (except DRIVER)
 */
router.get(
  "/slots",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;
      if (!companyCode || !date) {
        return res
          .status(400)
          .json({ ok: false, error: "companyCode & date required" });
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
 * ✅ Only MASTER / MANAGER
 */
router.post(
  "/slots/open-last",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.body;
      if (!companyCode || !date) {
        return res
          .status(400)
          .json({ ok: false, error: "companyCode & date required" });
      }

      const data = await managerOpenLastSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Book Slot
 * URL: /api/slots/book
 * ✅ Sales Officer + Distributor only
 */
router.post(
  "/slots/book",
  verifyToken,
  allowRoles("SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, distributorCode } =
        req.body;

      if (!companyCode || !date || !time || !vehicleType || !pos) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,vehicleType,pos required",
        });
      }

      // ✅ take userId from JWT token (NOT from body)
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
 * ✅ Sales Officer + Distributor only
 */
router.post(
  "/slots/cancel",
  verifyToken,
  allowRoles("SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos } = req.body;

      if (!companyCode || !date || !time || !vehicleType || !pos) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,vehicleType,pos required",
        });
      }

      const userId = req.user?.userId || req.user?.id;
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
 * ✅ Sales Officer + Distributor only
 */
router.post(
  "/slots/waiting",
  verifyToken,
  allowRoles("SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, distributorCode } = req.body;

      if (!companyCode || !date || !time) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time required",
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
