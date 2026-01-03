import express from "express";
import { assignCompany, getDrivers } from "./users.service.js";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

const router = express.Router();

// ✅ GET /users/drivers
router.get(
  "/drivers",
  verifyToken,
  allowRoles("MANAGER", "MASTER"),
  getDrivers
);

// ✅ existing route
router.post("/assign-company", assignCompany);

export default router;
