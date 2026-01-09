import { Router } from "express";
import {
  getAllowanceConfig,
  updateAllowanceConfig,
} from "./config.controller.js";

import { verifyToken } from "../../middleware/auth.middleware.js";

const router = Router();

// 🔐 MASTER ONLY (verified inside controller)
router.get("/allowance", verifyToken, getAllowanceConfig);
router.post("/allowance", verifyToken, updateAllowanceConfig);

export default router;
