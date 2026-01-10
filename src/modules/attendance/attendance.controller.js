import { AllowanceConfig } from "../../models/allowanceConfig.model.js";
import { Attendance } from "../../models/attendance.model.js";
import { calculateDistance } from "../../utils/distance.js";
import locations from "../../config/location.js";
import { LOADMAN_MOBILES } from "../../config/loadman.js";

const todayIST = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const yesterdayIST = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const toMinutes = (timeStr) => {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
};

const getISTNow = () =>
  new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );


export const checkIn = async (req, res) => {
  const { lat, lng } = req.body;

  const rawPk = req.user.pk;
  const uid = rawPk?.includes("#") ? rawPk.split("#")[1] : rawPk;

  const userName =
    req.user.name ||
    req.user.Name ||
    req.user.username ||
    "UNKNOWN";

  const role = req.user.role;

  // 🔑 DERIVED ATTENDANCE ROLE (ROLE TOUCH PANNA MAATTOM)
  let attendanceRole = role;
  if (role === "DRIVER" && LOADMAN_MOBILES.includes(uid)) {
    attendanceRole = "LOADMAN";
  }

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
    // ✅ 1. LOAD CONFIG FIRST
    const config = await AllowanceConfig.get();

    // ✅ 2. INIT VARIABLES
    let bataAmount = 0;
    let bataReason = "NOT_APPLICABLE";

    const now = getISTNow();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // ✅ 3. ROLE BASED LOGIC
    if (attendanceRole === "MANAGER" || attendanceRole === "LOADMAN") {
      const from = toMinutes(config.managerLoadmanCheckin.from);
      const to = toMinutes(config.managerLoadmanCheckin.to);

      if (nowMin >= from && nowMin <= to) {
        bataAmount = config.managerLoadmanBata;
        bataReason = "MANAGER_LOADMAN_ON_TIME";
      }
    }

    if (attendanceRole === "DRIVER") {
      const yesterday = await Attendance.get(uid, yesterdayIST());

      let window = config.driverCheckinNormal;

      if (yesterday?.checkOutAt) {
        const checkout = new Date(yesterday.checkOutAt);
        const checkoutMin =
          checkout.getHours() * 60 + checkout.getMinutes();

        if (checkoutMin >= 1320) {
          window = config.driverCheckinAfterNightDuty;
        }
      }

      const from = toMinutes(window.from);
      const to = toMinutes(window.to);

      if (nowMin >= from && nowMin <= to) {
        bataAmount = config.driverMorningBata;
        bataReason = "DRIVER_MORNING_BATA";
      }
    }

    // ✅ 4. SAVE ATTENDANCE
    await Attendance.checkIn({
      uid,
      userName,
      role,
      attendanceRole,   
      date: todayIST(),
      lat,
      lng,
      distance,
      locationId: matchedLocation.id,
      locationName: matchedLocation.name,
      bataAmount,
      bataReason,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("CHECKIN ERROR:", e);
    res.json({ ok: false, error: "already_checked_in" });
  }
};


export const checkOut = async (req, res) => {
  const { lat, lng } = req.body;
  const rawPk = req.user.pk; // "USER#9876543210"

const uid = rawPk?.includes("#")
  ? rawPk.split("#")[1]
  : rawPk;
const userName =
  req.user.name ||
  req.user.Name ||
  req.user.username ||
  "UNKNOWN";
  const role = req.user.role;

  if (!lat || !lng) {
    return res.json({ ok: false, error: "location_required" });
  }

  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const config = await AllowanceConfig.get();


  const attendance =
    await Attendance.get(uid, todayIST()) ||
    await Attendance.get(uid, yesterdayIST());

  if (!attendance) {
    return res.json({ ok: false, error: "no_checkin_found" });
  }

  const checkInTime = new Date(attendance.checkInAt);
  let deadline = new Date(checkInTime);
  deadline.setHours(23, 59, 59, 999);

  if (attendance.attendanceRole === "DRIVER"){
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(4, 0, 0, 0);
  }

  if (nowIST > deadline) {
    return res.json({ ok: false, error: "checkout_window_closed" });
  }

  const attendanceDate = attendance.SK.replace("DATE#", "");
  let nightAllowance = 0;

// 🔥 USE attendanceRole HERE
  if (attendance.attendanceRole === "DRIVER") {
    const nowMin =
      nowIST.getHours() * 60 + nowIST.getMinutes();

    if (nowMin >= 1320) {
      nightAllowance = config.driverNightAllowance;
    }
  }



  try {
    await Attendance.checkOut({
      uid,
      date: attendanceDate,
      lat,
      lng,
      // ✅ NEW
      nightAllowance
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, error: "already_checked_out" });
  }
};
