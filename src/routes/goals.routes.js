import express from "express";
import dayjs from "dayjs";
import { verifyToken } from "../middleware/auth.middleware.js";

import { getMonthlyGoalsForDistributor } from "../services/goals.service.js";

const router = express.Router();

/**
 * ✅ GET /goals/monthly?distributorCode=D024&month=2025-12
 *
 * ✅ distributorCode REQUIRED (because goals are distributor-wise)
 * ✅ month OPTIONAL (default = current YYYY-MM)
 *
 * ✅ Roles allowed:
 *  - SALES OFFICER
 *  - MANAGER
 *  - MASTER
 */
router.get("/monthly", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    const role = String(user.role || "").toUpperCase();

    // ✅ allow Sales + Manager + Master
    const allowedRoles = ["SALES OFFICER", "SALES_OFFICER", "MANAGER", "MASTER","SALES OFFICER VNR","SALES_OFFICER_VNR"];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        ok: false,
        message: "Access denied. Only Sales Officer / Manager / Master can view goals.",
      });
    }

    // ✅ distributorCode required
    const distributorCode = String(req.query.distributorCode || "").trim();
    if (!distributorCode) {
      return res.status(400).json({
        ok: false,
        message: "distributorCode query param required. Example: ?distributorCode=D024",
      });
    }

    // ✅ month optional
    const month = req.query.month || dayjs().format("YYYY-MM");

    const data = await getMonthlyGoalsForDistributor({
      distributorCode,
      month,
    });

    return res.json({
      ok: true,
      role,
      distributorCode,
      month,
      goals: data.goals || [],
      count: (data.goals || []).length,
    });
  } catch (err) {
    console.error("goals monthly error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});

export default router;
