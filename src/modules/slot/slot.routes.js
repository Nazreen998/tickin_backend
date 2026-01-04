import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  bookSlot,
  joinWaiting,
  managerCancelBooking,
  managerDisableSlot,
  managerConfirmMerge,
  managerMoveBookingToMerge,
  managerEditSlotTime,
  managerSetSlotMax,
  managerEnableSlot,
  managerToggleLastSlot,
  managerSetGlobalMax,
} from "../slot/slot.service.js";

const router = express.Router();

/* ✅ GET GRID */
router.get(
  "/",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;
      const data = await getSlotGrid({ companyCode, date });
      return res.json({ ok: true, slots: data });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ BOOK */
router.post(
  "/book",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const data = await bookSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ WAITING */
router.post(
  "/waiting",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const data = await joinWaiting(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER CANCEL */
router.post(
  "/manager/cancel-booking",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerCancelBooking(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER DISABLE SLOT */
router.post(
  "/disable-slot",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerDisableSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER ENABLE SLOT */
router.post(
  "/enable-slot",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerEnableSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER CONFIRM MERGE */
router.post(
  "/merge/confirm",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerConfirmMerge(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER MOVE MERGE */
router.post(
  "/merge/move",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerMoveBookingToMerge(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ EDIT MERGE SLOT TIME */
router.post(
  "/edit-time",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerEditSlotTime(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ SET MERGE SLOT MAX */
router.post(
  "/set-max",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerSetSlotMax(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ SET GLOBAL THRESHOLD */
router.post(
  "/set-global-max",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerSetGlobalMax(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ LAST SLOT TOGGLE */
router.post(
  "/last-slot/toggle",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerToggleLastSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

export default router;
