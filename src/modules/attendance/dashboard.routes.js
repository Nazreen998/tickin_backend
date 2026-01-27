import { Router } from "express";
import {
  todayAttendance,
  attendanceByDate,
  weeklySummary,
  monthlySummary
} from "./dashboard.controller.js";

import { verifyToken } from "../../middleware/auth.middleware.js";

const router = Router();

router.get("/today", verifyToken, todayAttendance);
router.get("/by-date", verifyToken, attendanceByDate);
router.get("/weekly-summary", verifyToken, weeklySummary);
router.get("/monthly-summary",verifyToken,monthlySummary);

export default router;
