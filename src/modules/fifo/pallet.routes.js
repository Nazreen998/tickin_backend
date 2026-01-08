import { Router } from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import {
  scanPallet,
  createPallet,
  consumeCases,
  fifoDashboard
} from "./pallet.controller.js";

const router = Router();

router.get("/inventory/pallets/:palletId", verifyToken, scanPallet);
router.post("/pallets", verifyToken, createPallet);
router.post("/pallets/consume", verifyToken, consumeCases);
router.get("/dashboard/pallets", verifyToken, fifoDashboard);

export default router;
