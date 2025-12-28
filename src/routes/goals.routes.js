import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getMonthlyGoalsForSalesman } from "../services/goals.service.js";

const router = express.Router();

/**
 * ✅ GET /api/goals/monthly
 * Salesman -> see own product goals
 * Manager/Master -> blocked for now (you can allow later if needed)
 */
router.get("/monthly", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "SALES OFFICER") {
      return res.status(403).json({ message: "Only Sales Officer can view goals" });
    }

    const data = await getMonthlyGoalsForSalesman({
      salesmanId: user.userId,
    });

    return res.json(data);
  } catch (err) {
    console.error("goals monthly error:", err);
    return res.status(500).json({ message: err.message });
  }
});

export default router;
