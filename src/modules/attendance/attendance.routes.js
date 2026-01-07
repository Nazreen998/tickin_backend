import { Router } from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { checkIn, checkOut } from "./attendance.controller.js";

const router = Router();

router.post("/check-in", verifyToken, checkIn);
router.post("/check-out", verifyToken, checkOut);


export default router;
