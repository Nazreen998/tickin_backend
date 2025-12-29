import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { getMonthlyGoalsForSalesman } from "../services/goals.service.js";

const router = express.Router();

/**
 * ✅ GET /goals/monthly
 * Optional: /goals/monthly?month=2025-12
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

    const data = await getMonthlyGoalsForSalesman({
      salesmanId: user.mobile,
      month,
    });

    return res.json(data);
  } catch (err) {
    console.error("goals monthly error:", err);
    return res.status(500).json({ message: err.message });
  }
});

export default router;
