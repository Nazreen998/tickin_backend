import express from "express";
const router = express.Router();

import {
  getSlotGrid,
  managerOpenLastSlot,
  bookSlot,
  cancelSlot,
  joinWaiting,
} from "./slot.service.js";

// ✅ GET slot grid
router.get("/slots", async (req, res) => {
  try {
    const { companyCode, date } = req.query;
    if (!companyCode || !date)
      return res.status(400).json({ ok: false, message: "companyCode & date required" });

    const data = await getSlotGrid({ companyCode, date });
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ✅ Manager open last slot
router.post("/slots/manager-open", async (req, res) => {
  try {
    const { companyCode, date, vehicleType, time, allowedPositions } = req.body;
    if (!companyCode || !date)
      return res.status(400).json({ ok: false, message: "companyCode & date required" });

    const out = await managerOpenLastSlot({
      companyCode,
      date,
      vehicleType: vehicleType || "FULL",
      time: time || "20:30",
      allowedPositions: allowedPositions || ["A", "B"],
    });

    return res.json(out);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
});

// ✅ Book slot
router.post("/slots/book", async (req, res) => {
  try {
    const { companyCode, date, time, vehicleType, pos, userId, distributorCode } = req.body;

    if (!companyCode || !date || !time || !vehicleType || !pos || !userId) {
      return res.status(400).json({ ok: false, message: "companyCode,date,time,vehicleType,pos,userId required" });
    }

    const out = await bookSlot({ companyCode, date, time, vehicleType, pos, userId, distributorCode });
    return res.json(out);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
});

// ✅ Cancel slot
router.post("/slots/cancel", async (req, res) => {
  try {
    const { companyCode, date, time, vehicleType, pos, userId } = req.body;

    if (!companyCode || !date || !time || !vehicleType || !pos || !userId) {
      return res.status(400).json({ ok: false, message: "companyCode,date,time,vehicleType,pos,userId required" });
    }

    const out = await cancelSlot({ companyCode, date, time, vehicleType, pos, userId });
    return res.json(out);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
});

// ✅ Waiting queue
router.post("/slots/waiting", async (req, res) => {
  try {
    const { companyCode, date, time, vehicleType, userId, distributorCode } = req.body;

    if (!companyCode || !date || !time || !userId) {
      return res.status(400).json({ ok: false, message: "companyCode,date,time,userId required" });
    }

    const out = await joinWaiting({
      companyCode,
      date,
      time,
      vehicleType: vehicleType || "HALF",
      userId,
      distributorCode,
    });

    return res.json(out);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
});

export default router;
