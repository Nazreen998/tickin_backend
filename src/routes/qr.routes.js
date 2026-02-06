import express from "express";
import {
  scanQr,
  takeStock,
  addNewBatch,
  getQrHistoryController
} from "../controllers/qr.controller.js";

const router = express.Router();

// ✅ History list (must be BEFORE /:qrName)
router.get("/history/list", getQrHistoryController);

// TAKE stock
router.post("/take", takeStock);

// ADD new batch
router.post("/add", addNewBatch);

// ✅ Scan QR must be LAST
router.get("/:qrName", scanQr);

export default router;
