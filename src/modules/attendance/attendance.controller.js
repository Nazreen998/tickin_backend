import { Attendance } from "../../models/attendance.model.js";
import { calculateDistance } from "../../utils/distance.js";
import locations from "../../config/location.js";

const todayIST = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const yesterdayIST = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

export const checkIn = async (req, res) => {
  const { lat, lng } = req.body;
// ✅ SAFE UID EXTRACTION
const rawPk = req.user.pk; // "USER#9876543210"

const uid = rawPk?.includes("#")
  ? rawPk.split("#")[1]
  : rawPk;
const userName =
  req.user.name ||
  req.user.Name ||
  req.user.username ||
  "UNKNOWN";
  if (!lat || !lng) {
    return res.json({ ok: false, error: "location_required" });
  }

  let matchedLocation = null;
  let distance = null;

  for (const loc of locations) {
    const d = calculateDistance(lat, lng, loc.lat, loc.lng);
    if (d <= loc.radius) {
      matchedLocation = loc;
      distance = Math.round(d);
      break;
    }
  }

  if (!matchedLocation) {
    return res.json({ ok: false, error: "outside_all_locations" });
  }

  try {
    await Attendance.checkIn({
      uid,
      userName,
      date: todayIST(),
      lat,
      lng,
      distance,
      locationId: matchedLocation.id,
      locationName: matchedLocation.name
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, error: "already_checked_in" });
  }
};

export const checkOut = async (req, res) => {
  const { lat, lng } = req.body;
  const uid = req.user.uid;
  const role = req.user.role;

  if (!lat || !lng) {
    return res.json({ ok: false, error: "location_required" });
  }

  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

  const attendance =
    await Attendance.get(uid, todayIST()) ||
    await Attendance.get(uid, yesterdayIST());

  if (!attendance) {
    return res.json({ ok: false, error: "no_checkin_found" });
  }

  const checkInTime = new Date(attendance.checkInAt);
  let deadline = new Date(checkInTime);
  deadline.setHours(23, 59, 59, 999);

  if (role === "DRIVER") {
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(4, 0, 0, 0);
  }

  if (nowIST > deadline) {
    return res.json({ ok: false, error: "checkout_window_closed" });
  }

  const attendanceDate = attendance.SK.replace("DATE#", "");

  try {
    await Attendance.checkOut({
      uid,
      date: attendanceDate,
      lat,
      lng
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, error: "already_checked_out" });
  }
};
