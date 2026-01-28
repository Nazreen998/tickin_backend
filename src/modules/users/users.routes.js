import express from "express";
import { getDrivers,addPlayerId} from "./users.service.js";
import { verifyToken } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.get("/drivers", getDrivers);

// 🔥 ADD THIS-to save onesignal playerid
router.post(
  "/me/player-id",
  verifyToken,
  addPlayerId
);

export default router;
