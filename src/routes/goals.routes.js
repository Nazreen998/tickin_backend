import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { getMonthlyGoalsForDistributor } from "../services/goals.service.js";

const router = express.Router();

/**
 * ✅ GET /goals/monthly?distributorCode=D024&month=2025-12
 * month optional
 * distributorCode REQUIRED (because goals are distributor-wise)
 */
router.get("/monthly", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    const role = (user.role || "").toUpperCase();
    if (role !== "SALES OFFICER" && role !== "SALES_OFFICER") {
      return res.status(403).json({
        message: "Only Sales Officer can view goals",
      });
    }

    const month = req.query.month; // optional
    const distributorCode = String(req.query.distributorCode || "").trim();

    if (!distributorCode) {
      return res.status(400).json({
        ok: false,
        message: "distributorCode query param required",
      });
    }

    const data = await getMonthlyGoalsForDistributor({
      distributorCode,
      month,
    });

    return res.json(data);
  } catch (err) {
    console.error("goals monthly error:", err);
    return res.status(500).json({ message: err.message });
  }
});

export default router;
