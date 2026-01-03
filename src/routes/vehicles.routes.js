import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { getAvailableVehicles } from "./vehicles.service.js";

const router = express.Router();

// ✅ GET /vehicles/available
router.get(
  "/available",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  getAvailableVehicles
);

export default router;
