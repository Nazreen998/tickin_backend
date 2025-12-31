import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
  managerSetSlotMaxAmount,
  managerAssignCluster,
} from "./slot.service.js";

const router = express.Router();

/** ----------------- HELPERS ----------------- */

// ✅ Manager check (supports both role and roles[])
function isManager(req) {
  return (
    req.user?.role === "MANAGER" ||
    req.user?.role === "MASTER" ||
    req.user?.roles?.includes("MANAGER") ||
    req.user?.roles?.includes("MASTER")
  );
}

// ✅ Extract distributorCode safely from token (handles all formats)
function getUserDistributorCode(req) {
  const v =
    req.user?.distributorCode ||
    req.user?.distributorId ||
    req.user?.distributor_code ||
    req.user?.distributor ||
    null;

  // if format like "DISTRIBUTOR#D031" take last part
  if (typeof v === "string" && v.includes("#")) return v.split("#").pop();
  return v;
}

// ✅ validate own distributor (for sales officer / distributor)
function normalizeCode(x) {
  return String(x || "")
    .trim()
    .toUpperCase()
    .replace("DISTRIBUTOR#", "")
    .replace("DIST#", "");
}

function validateOwnDistributor(req, distributorCode) {
  const code = normalizeCode(distributorCode);

  const list =
    req.user?.allowedDistributorCodes ||
    req.user?.distributorCodes ||
    req.user?.distributorCodeList ||
    req.user?.mappedDistributorCodes ||
    req.user?.distributors ||
    req.user?.distributorList ||
    null;

  if (Array.isArray(list)) {
    const codes = list.map((d) =>
      normalizeCode(d?.code || d?.distributorCode || d)
    );
    return codes.includes(code);
  }

  const single =
    req.user?.distributorCode ||
    req.user?.distributorId ||
    req.user?.distributor_code ||
    req.user?.distributor ||
    null;

  if (!single) return false;

  return normalizeCode(single) === code;
}

/**
 * ✅ GET SLOT GRID
 * URL: /api/slots?companyCode=ABC&date=2025-12-27
 * ✅ MASTER / MANAGER / SALES OFFICER / DISTRIBUTOR can view
 */
router.get(
  "/slots",
  verifyToken,
  allowRoles(
    "MASTER",
    "MANAGER",
    "SALES OFFICER",
    "DISTRIBUTOR",
    "SALESMAN",
    "SALES OFFICE"
  ),
  async (req, res) => {
    try {
      const { companyCode, date } = req.query;
      if (!companyCode || !date) {
        return res.status(400).json({
          ok: false,
          error: "companyCode & date required",
        });
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
 * ✅ AFTER 5PM ONLY (enforced in service)
 */
router.post(
  "/slots/open-last",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date } = req.body;
      if (!companyCode || !date) {
        return res.status(400).json({
          ok: false,
          error: "companyCode & date required",
        });
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
      const { companyCode, date, time, mergeKey, location, maxAmount } = req.body;

      if (!companyCode || !date || !time || (!mergeKey && !location) || !maxAmount) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,(mergeKey or location),maxAmount required",
        });
      }

      const out = await managerSetSlotMaxAmount({
        companyCode,
        date,
        time,
        mergeKey: mergeKey || null,
        location: location || null,
        maxAmount: Number(maxAmount),
      });

      return res.json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ✅ Manager Manual Merge (Option B)
 * URL: /api/slots/cluster/assign
 * ✅ Only MANAGER
 */
router.post(
  "/slots/cluster/assign",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, orderId, distributorCode, clusterId } = req.body;

      if (!companyCode || !date || !distributorCode || !clusterId) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,distributorCode,clusterId required",
        });
      }

      const out = await managerAssignCluster({
        companyCode,
        date,
        orderId: orderId || "",
        distributorCode,
        clusterId,
      });

      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/**
 * ✅ Book Slot
 * URL: /api/slots/book
 *
 * ✅ Amount based auto:
 *    - >= 80,000 => FULL (pos required A/B/C/D)
 *    - < 80,000  => HALF (amount required)
 *
 * ✅ Sales Officer/Distributor only can book own distributorCode
 * ✅ Manager can book any distributorCode
 */
router.post(
  "/slots/book",
  verifyToken,
  allowRoles("MANAGER", "MASTER", "SALES OFFICER", "SALES OFFICE", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const { companyCode, date, time, pos, distributorCode, amount, orderId } = req.body;

      if (!companyCode || !date || !time || !distributorCode) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,distributorCode required",
        });
      }

      // ✅ own distributor restriction only for non-manager
      if (!isManager(req)) {
        if (!validateOwnDistributor(req, distributorCode)) {
          return res.status(403).json({
            ok: false,
            error: "You can book slot only for your own distributorCode",
          });
        }
      }

      // ✅ auto decide FULL/HALF by amount
      const amt = Number(amount || 0);
      const vehicleType = amt >= 80000 ? "FULL" : "HALF";

      // ✅ FULL validations
      if (vehicleType === "FULL") {
        const validPos = ["A", "B", "C", "D"];
        if (!pos) {
          return res.status(400).json({
            ok: false,
            error: "pos required for FULL booking",
          });
        }
        if (!validPos.includes(String(pos).toUpperCase())) {
          return res.status(400).json({
            ok: false,
            error: "pos must be one of A,B,C,D",
          });
        }
      }

      // ✅ HALF validations
      if (vehicleType === "HALF" && (!amt || amt <= 0)) {
        return res.status(400).json({
          ok: false,
          error: "amount required for HALF booking",
        });
      }

      // ✅ take userId from JWT token (your token uses pk)
      const userId =
        req.user?.pk ||
        req.user?.userId ||
        req.user?.id ||
        req.user?._id ||
        req.user?.uid;

      if (!userId) {
        return res.status(401).json({ ok: false, error: "Invalid token userId" });
      }

      const requesterRole = req.user?.role || "UNKNOWN";
      const requesterDistributorCode = getUserDistributorCode(req);

      const data = await bookSlot({
        companyCode,
        date,
        time,
        vehicleType,
        pos,
        distributorCode,
        userId,
        amount: amt,
        orderId,

        requesterRole,
        requesterDistributorCode,
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
 * ✅ Only MANAGER can cancel
 */
router.post(
  "/slots/cancel",
  verifyToken,
  allowRoles("MANAGER"),
  async (req, res) => {
    try {
      const { companyCode, date, time, vehicleType, pos, targetUserId, orderId } = req.body;

      if (!companyCode || !date || !time || !vehicleType) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,vehicleType required",
        });
      }

      // ✅ FULL cancel requires pos
      if (vehicleType === "FULL" && !pos) {
        return res.status(400).json({
          ok: false,
          error: "pos required for FULL cancel",
        });
      }

      const userId = targetUserId || req.user?.pk || req.user?.userId || req.user?.id;

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
        orderId,
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
 * ✅ restriction: only own distributorCode except manager
 */
router.post(
  "/slots/waiting",
  verifyToken,
  allowRoles("MANAGER", "MASTER", "SALES OFFICER", "SALES OFFICE", "DISTRIBUTOR"),
  async (req, res) => {
    try {
      const { companyCode, date, time, distributorCode, vehicleType, orderId } = req.body;

      if (!companyCode || !date || !time || !distributorCode) {
        return res.status(400).json({
          ok: false,
          error: "companyCode,date,time,distributorCode required",
        });
      }

      // ✅ own distributor restriction only for non-manager
      if (!isManager(req)) {
        if (!validateOwnDistributor(req, distributorCode)) {
          return res.status(403).json({
            ok: false,
            error: "You can join waiting queue only for your own distributorCode",
          });
        }
      }

      const userId = req.user?.pk || req.user?.userId || req.user?.id;

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
        orderId,
      });

      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
