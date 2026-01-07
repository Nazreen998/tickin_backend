import { Attendance } from "../../models/attendance.model.js";
import { calculateDistance } from "../../utils/distance.js";

const COMPANY_LAT = 9.8846830;
const COMPANY_LNG = 78.1432800;
const RANGE = 30; // meters

const todayIST = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export const checkIn = async (req, res) => {
  const { lat, lng } = req.body;
  const uid = req.user.uid;

  if (!lat || !lng) {
    return res.json({ ok: false, error: "location_required" });
  }

  const dist = calculateDistance(lat, lng, COMPANY_LAT, COMPANY_LNG);
  if (dist > RANGE) {
    return res.json({ ok: false, error: "outside_range" });
  }

  try {
    await Attendance.checkIn({
      uid,
      date: todayIST(),
      lat,
      lng,
      distance: Math.round(dist)
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, error: "already_checked_in" });
  }
};

export const checkOut = async (req, res) => {
  const uid = req.user.uid;

  try {
    await Attendance.checkOut({
      uid,
      date: todayIST()
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, error: "no_checkin_found" });
  }
};
