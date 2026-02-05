import express from "express";
import {
  scanQr,
  takeStock,
  addNewBatch
} from "../controllers/qr.controller.js";

const router = express.Router();

router.get("/:qrName", scanQr);      // GET /qr/A2
router.post("/take", takeStock);     // POST /qr/take
router.post("/add", addNewBatch);    // POST /qr/add

export default router;
