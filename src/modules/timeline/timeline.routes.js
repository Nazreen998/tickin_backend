import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { getOrderTimeline } from "./timeline.service.js";

const router = express.Router();

router.get(
  "/:orderId",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "DISTRIBUTOR", "DRIVER", "SALES OFFICER"),
  getOrderTimeline
);

export default router;
