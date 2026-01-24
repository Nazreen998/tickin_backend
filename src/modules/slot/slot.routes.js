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
  managerCancelConfirmedDayMerge,
  managerMoveBookingToMerge,
  getWaitingHalfBookingsByDate,
  getBlinkGroupsByDateLocation,
  managerConfirmDayMerge,
  managerEditSlotTime,
  managerSetSlotMax,
  managerEnableSlot,
  managerToggleLastSlot,
  managerManualCrossSessionMerge,
  managerMergeOrdersToMergeKey,
  managerSetGlobalMax,
  getAvailableFullTimes,
  managerManualMergePickTime,
  getEligibleHalfBookings,
} from "../slot/slot.service.js";

// ✅ NEW: Slot Timeline writer
import { requireAuth as auth } from "../../middleware/auth.middleware.js";
import { addTimelineEvent, addSlotTimelineEvent } from "../timeline/timeline.helper.js";
const router = express.Router();

/* ✅ helper: extract slotId safely from any response */
function extractSlotId(out) {
  if (!out) return null;
  return (
    out.slotId ||
    out.slotID ||
    out?.data?.slotId ||
    out?.data?.slotID ||
    out?.booking?.slotId ||
    out?.booking?.slotID ||
    out?.result?.slotId ||
    out?.result?.slotID ||
    null
  );
}
router.get(
  "/available-full-times",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { date } = req.query;
      const companyCode = req.user?.companyCode || "VAGR_IT";
      const out = await getAvailableFullTimes({ companyCode, date });
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message });
    }
  }
);
router.post(
  "/merge/manual-pick-time",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const out = await managerManualMergePickTime({
        companyCode: req.user?.companyCode || req.body.companyCode || "VAGR_IT",
        date: req.body.date,
        bookingSks: req.body.bookingSks || [],
        targetTime: req.body.targetTime,
        managerId: req.user?.userId || req.user?.mobile || "MANAGER",
      });

      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  }
);
/* ✅ helper: extract orderId safely */
function extractOrderId(out, body) {
  if (!out && !body) return null;
  return out?.orderId || out?.data?.orderId || body?.orderId || null;
}

/* ✅ Eligible HALF bookings (Manager only) */
router.get(
  "/eligible-half-bookings",
  verifyToken,
  allowRoles("MANAGER"),
  getEligibleHalfBookings
);
router.post(
  "/manager/manual-cross-session-merge",
  verifyToken,
  allowRoles(["MANAGER", "ADMIN"]),
  async (req, res) => {
    try {
      const out = await managerManualCrossSessionMerge({
        companyCode: req.user?.companyCode || req.body.companyCode,
        ...req.body,
      });
      return res.json({ ok: true, ...out });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message });
    }
  }
);
// TIME-based confirmed merge cancel (existing)
router.post("/manager/cancel-confirmed-merge", auth, async (req, res) => {
  try {
    const out = await managerCancelConfirmedMerge({
      companyCode: req.user.companyCode,
      ...req.body,
      managerId: req.user.userId,
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ✅ DAY-based confirmed merge cancel (NEW)
router.post("/manager/cancel-confirmed-day-merge", auth, async (req, res) => {
  try {
    const out = await managerCancelConfirmedDayMerge({
      companyCode: req.user.companyCode,
      ...req.body,
      managerId: req.user.userId,
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

router.get(
  "/waiting-half-by-date",
  verifyToken,
  allowRoles("MANAGER"),
  getWaitingHalfBookingsByDate
);
/* ✅ Blink groups by Date + Location (MANAGER) */
router.get(
  "/blink-groups",
  verifyToken,
  allowRoles("MANAGER"),
  getBlinkGroupsByDateLocation
);

/* ✅ GET GRID */
router.get(
  "/",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;

      if (!companyCode || !date) {
        return res
          .status(400)
          .json({ ok: false, message: "companyCode & date required" });
      }

      const data = await getSlotGrid({ companyCode, date });

      return res.json({
        ok: true,
        ...data,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

/* ✅ Manual Merge */
router.post(
  "/merge/orders/manual",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const out = await managerMergeOrdersToMergeKey(req.body);
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  }
);

/* ✅ BOOK SLOT */
router.post(
  "/book",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const user = req.user || {};
      const out = await bookSlot(req.body);

      const slotId = extractSlotId(out);
      const orderId = extractOrderId(out, req.body);

      // ✅ 1) SLOT TIMELINE TABLE (tickin_timeline_events)
      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          orderId,
          event: "SLOT_BOOKING",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          amount: Number(req.body?.amount || req.body?.totalAmount || 0),
          data: {
            slotId,
            companyCode: req.body?.companyCode || null,
            date: req.body?.date || null,
            time: req.body?.time || null,
            bookingType: req.body?.slotType || req.body?.type || null,
          },
        });
      }

      // ✅ 2) ORDER TIMELINE TABLE (tickin_timeline)  ==> IMPORTANT for neatTimeline DONE
      if (orderId) {
        await addTimelineEvent({
          orderId,
          event: "SLOT_BOOKING",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          data: {
            slotId,
            companyCode: req.body?.companyCode || null,
            date: req.body?.date || null,
            time: req.body?.time || null,
            bookingType: req.body?.slotType || req.body?.type || null,
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await joinWaiting(req.body);

      const slotId = extractSlotId(out);
      const orderId = extractOrderId(out, req.body);

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          orderId,
          event: "WAITING_JOINED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          amount: Number(req.body?.amount || req.body?.totalAmount || 0),
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

/* ✅ MANAGER CANCEL BOOKING */
router.post(
  "/manager/cancel-booking",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const user = req.user || {};
      const out = await managerCancelBooking(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;
      const orderId = extractOrderId(out, req.body);

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          orderId,
          event: "BOOKING_CANCELLED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          amount: Number(req.body?.amount || req.body?.totalAmount || 0),
          data: {
            reason: req.body?.reason || null,
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerDisableSlot(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "SLOT_DISABLED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerEnableSlot(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "SLOT_ENABLED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerConfirmMerge(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      // ✅ slot timeline
      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "MERGE_CONFIRMED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      // ✅ IMPORTANT: orderIds from response (best)
      const orderIds =
        out?.orderIds ||
        out?.orders ||
        out?.data?.orderIds ||
        req.body?.orderIds ||
        [];

      // ✅ write SLOT_BOOKING_COMPLETED for each order
      if (Array.isArray(orderIds)) {
        for (const oid of orderIds) {
          if (!oid) continue;

          await addTimelineEvent({
            orderId: String(oid),
            event: "SLOT_BOOKING_COMPLETED",
            by: user.mobile || user.userId || "SYSTEM",
            byUserName: user.name || user.userName || null,
            role: user.role || null,
            data: {
              slotId,
              mergeKey: out?.mergeKey || out?.flowKey || null,
            },
          });

          // ✅ optional: ORDER_CONFIRMED also at merge time
          await addTimelineEvent({
            orderId: String(oid),
            event: "ORDER_CONFIRMED",
            by: user.mobile || user.userId || "SYSTEM",
            byUserName: user.name || user.userName || null,
            role: user.role || null,
            data: { slotId },
          });
        }
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);
/* ✅ MANAGER CONFIRM DAY MERGE (ignore HALF times; choose targetTime) */
router.post(
  "/merge/confirm-day",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const user = req.user || {};

      const out = await managerConfirmDayMerge({
        companyCode: req.user?.companyCode || req.body.companyCode || "VAGR_IT",
        date: req.body.date,
        mergeKey: req.body.mergeKey,       // ex: "LOC#2"
        targetTime: req.body.targetTime,   // ex: "15:00"
        managerId: user.userId || user.mobile || "MANAGER",
      });

      // ✅ slot timeline event
      const slotId = extractSlotId(out);
      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          orderId: out?.fullOrderId || null,
          event: "DAY_MERGE_CONFIRMED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: null,
          amount: Number(out?.totalAmount || 0),
          data: { originalBody: req.body || {} },
        });
      }

      // ✅ update child orders timeline
      const mergedOrderIds = out?.mergedOrderIds || [];
      for (const oid of mergedOrderIds) {
        if (!oid) continue;
        await addTimelineEvent({
          orderId: String(oid),
          event: "SLOT_BOOKING_COMPLETED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          data: { slotId, mergeKey: out?.mergeKey || null },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

/* ✅ MANAGER CANCEL CONFIRMED MERGE */
router.post(
  "/merge/cancel-confirm",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const user = req.user || {};
      const out = await managerCancelConfirmedMerge(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "MERGE_CANCELLED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerMoveBookingToMerge(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "MERGE_MOVED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerEditSlotTime(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "SLOT_TIME_EDITED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerSetSlotMax(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "SLOT_MAX_CHANGED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerSetGlobalMax(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "GLOBAL_MAX_CHANGED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
      const user = req.user || {};
      const out = await managerToggleLastSlot(req.body);

      const slotId = extractSlotId(out) || req.body?.slotId || req.body?.slotID;

      if (slotId) {
        await addSlotTimelineEvent({
          slotId,
          event: "LAST_SLOT_TOGGLED",
          by: user.mobile || user.userId || "SYSTEM",
          byUserName: user.name || user.userName || null,
          role: user.role || null,
          distributorName: req.body?.distributorName || null,
          data: {
            originalBody: req.body || {},
          },
        });
      }

      return res.json(out);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
);

router.post(
  "/merge/manual-cross-session",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const out = await managerManualCrossSessionMerge({
        ...req.body,
        managerId: req.user?.userId || req.user?.mobile || "MANAGER",
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  }
);

export default router;
