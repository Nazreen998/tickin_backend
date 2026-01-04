import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { getAvailableVehicles, addVehicle } from "./vehicles.service.js";

const router = express.Router();
console.log("✅ vehicles.routes.js LOADED");

// ✅ GET /vehicles/available
router.get(
  "/available",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  getAvailableVehicles
);
router.post(
  "/add",
  verifyToken,
  allowRoles("MANAGER"),
  addVehicle
);


export default router;
