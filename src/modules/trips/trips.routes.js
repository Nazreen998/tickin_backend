import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { getTripsList, getTripDetails, updateTripStatus } from "./trips.service.js";

const router = express.Router();

// ✅ Master/Manager see all trips
router.get(
  "/",
  verifyToken,
  allowRoles("MASTER", "MANAGER"),
  getTripsList
);

// ✅ Master/Manager/Sales/Distributor view trip details
router.get(
  "/:tripId",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR"),
  getTripDetails
);

// ✅ Manager update trip flow (vehicle choose, driver assign, status update)
router.patch(
  "/:tripId/status",
  verifyToken,
  allowRoles("MANAGER"),
  updateTripStatus
);

export default router;
