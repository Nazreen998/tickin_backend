import express from "express";
const router = express.Router();

import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
} from "./slot.service.js";

// ✅ GET slot grid
// Roles: MASTER, MANAGER, SALES OFFICER, DISTRIBUTOR
router.get(
  "/slots",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;
      if (!companyCode || !date)
        return res
          .status(400)
          .json({ ok: false, message: "companyCode & date required" });

      const data = await getSlotGrid({ companyCode, date });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

// ✅ Manager open last slot
// Roles: MASTER, MANAGER only
router.post(
  "/slots/manager-open",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, vehicleType, time, allowedPositions } = req.body;
      if (!companyCode || !date)
        return res
          .status(400)
          .json({ ok: false, message: "companyCode & date required" });

      const out = await managerOpenLastSlot({
        companyCode,
        date,
        vehicleType: vehicleType || "FULL",
        time: time || "20:30",
        allowedPositions: allowedPositions || ["A", "B"],
      });

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// ✅ Book slot
// Roles: SALES OFFICER, DISTRIBUTOR only
router.post(
  "/slots/book",
  verifyToken,
  allowRoles("SALES OFFICER", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, distributorCode } = req.body;

      if (!companyCode || !date || !time || !vehicleType || !pos) {
        return res.status(400).json({
          ok: false,
          message: "companyCode,date,time,vehicleType,pos required",
        });
      }

      // ✅ Always take userId from token
      const userId = req.user.userId;

      const out = await bookSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        userId,
        distributorCode,
      });

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// ✅ Cancel slot
// Roles: SALES OFFICER, DISTRIBUTOR only
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
          message: "companyCode,date,time,vehicleType,pos required",
        });
      }

      const userId = req.user.userId;

      const out = await cancelSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        userId,
      });

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// ✅ Waiting queue
// Roles: SALES OFFICER, DISTRIBUTOR only
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
          message: "companyCode,date,time required",
        });
      }

      const userId = req.user.userId;

      const out = await joinWaiting({
        companyCode,
        date,
        time,
        vehicleType: vehicleType || "HALF",
        userId,
        distributorCode,
      });

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

export default router;
