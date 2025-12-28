import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { getMonthlyGoalsForSalesman } from "../services/goals.service.js";

const router = express.Router();

router.get("/monthly", verifyToken, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "SALES OFFICER") {
      return res.status(403).json({ message: "Only Sales Officer can view goals" });
    }

    const data = await getMonthlyGoalsForSalesman({
      salesmanId: user.mobile, // ✅ salesman wise tracking mobile
    });

    return res.json(data);
  } catch (err) {
    console.error("goals monthly error:", err);
    return res.status(500).json({ message: err.message });
  }
});

export default router;
