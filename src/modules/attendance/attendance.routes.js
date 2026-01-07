import { Router } from "express";
import auth from "../../middleware/auth.js";
import { checkIn, checkOut } from "./attendance.controller.js";

const router = Router();

router.post("/checkin", auth, checkIn);
router.post("/checkout", auth, checkOut);

export default router;
