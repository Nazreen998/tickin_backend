import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
  managerAssignCluster,
   managerConfirmMerge,          // ✅ ADD
  managerMoveBookingToMerge,

  managerCancelBooking,
  managerDisableSlot,
  managerEditSlotTime,
  managerSetSlotMax,
} from "./slot.service.js";

const router = express.Router();
/**Manager cancel slot */
router.post(
  "/manager/cancel-booking",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerCancelBooking(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);
/*Manager disable slot*/
router.post(
  "/disable-slot",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerDisableSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

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
      return res.status(500).json({ ok: false, error: err.message });
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
      return res.status(500).json({ ok: false, error: err.message });
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
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ CANCEL */
router.post(
  "/cancel",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await cancelSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ OPEN LAST SLOT */
router.post(
  "/open-last",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerOpenLastSlot(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ CLUSTER ASSIGN */
router.post(
  "/cluster/assign",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerAssignCluster(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
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
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/* ✅ MANAGER MOVE BOOKING */
router.post(
  "/merge/move",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerMoveBookingToMerge(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

router.post(
  "/set-max",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerSetSlotMax(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);
import { managerEditSlotTime } from "./slot.service.js";

router.post(
  "/edit-time",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const data = await managerEditSlotTime(req.body);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);


export default router;
