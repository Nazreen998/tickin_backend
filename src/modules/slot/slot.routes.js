import express from "express";
import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
} from "./slot.service.js";

const router = express.Router();

/**
 * ✅ GET SLOT GRID
 * URL: /api/slots?companyCode=ABC&date=2025-12-27
 */
router.get("/slots", async (req, res) => {
  try {
    const { companyCode, date } = req.query;
    const data = await getSlotGrid({ companyCode, date });
    return res.json({ ok: true, slots: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ Manager Open Last Slot
 * URL: /api/slots/open-last
 */
router.post("/slots/open-last", async (req, res) => {
  try {
    const data = await managerOpenLastSlot(req.body);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ Book Slot
 * URL: /api/slots/book
 */
router.post("/slots/book", async (req, res) => {
  try {
    const data = await bookSlot(req.body);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ Cancel Slot
 * URL: /api/slots/cancel
 */
router.post("/slots/cancel", async (req, res) => {
  try {
    const data = await cancelSlot(req.body);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ Join Waiting Queue
 * URL: /api/slots/waiting
 */
router.post("/slots/waiting", async (req, res) => {
  try {
    const data = await joinWaiting(req.body);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
