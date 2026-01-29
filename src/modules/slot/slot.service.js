import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent, markOrderAsMerged } from "../timeline/timeline.helper.js";
import { resolveMergeKeyByRadius, haversineKm } from "./geoMerge.helper.js";
import { pairingMap } from "../../appInit.js";
import { getDistributorByCode } from "../distributors/distributors.service.js";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  QueryCommand,
  ScanCommand, 
} from "@aws-sdk/lib-dynamodb";

import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";


dayjs.extend(utc);
dayjs.extend(timezone);
const IST_TZ = process.env.APP_TZ || "Asia/Kolkata";

const TABLE_CAPACITY = process.env.TABLE_CAPACITY || "tickin_slot_capacity";
const TABLE_BOOKINGS = process.env.TABLE_BOOKINGS || "tickin_slot_bookings";
const TABLE_QUEUE = process.env.TABLE_QUEUE || "tickin_slot_waiting_queue";
const TABLE_RULES = process.env.TABLE_RULES || "tickin_slot_rules";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

const DEFAULT_SLOT_TIMES = {
  Morning: ["09:00","09:30","10:00","10:30"],
  Afternoon: ["12:00","12:30","13:00","13:30"],
  Evening: ["15:00","15:30","16:00","16:30"],
  Night: ["18:00","18:30","19:00","19:30"],
};

function flattenSlotTimes(slotTimes) {
  const st = (slotTimes && typeof slotTimes === "object") ? slotTimes : DEFAULT_SLOT_TIMES;

  return [
    ...(st.Morning || []),
    ...(st.Afternoon || []),
    ...(st.Evening || []),
    ...(st.Night || []),
  ];
}

const ALL_POSITIONS = ["A", "B", "C", "D"];

const DEFAULT_THRESHOLD = Number(process.env.DEFAULT_MAX_AMOUNT || 80000);
const MERGE_RADIUS_KM = Number(process.env.MERGE_RADIUS_KM || 25);

const LAST_SLOT_TIME = "19:30";

/* ============================================================
   ✅ Eligible HALF Bookings (Manual Merge list API)
============================================================ */

const ELIGIBLE_STATUSES = [
   "PENDING_MANAGER_CONFIRM",
  "WAITING_MANAGER_CONFIRM",
  "PENDING",
  "WAITING",
  "READY",
  "READY_FOR_CONFIRM",
];
// --- HALF merge: cancel ---
export async function cancelHalfMerge(req, res) {
  try {
    const { date, time, mergeKey, orderIds = [], mode } = req.body;
    const companyCode = req.user?.companyCode || "VAGR_IT";
    const managerId = req.user?.userId || req.user?.id || "MANAGER";

    if (!date || !mergeKey) {
      return res.status(400).json({ ok: false, message: "date, mergeKey required" });
    }

    // ✅ DAY-level cancel (already confirmed FULL)
    if (String(mode || "").toUpperCase() === "DAY") {
      const out = await managerCancelConfirmedDayMerge({
        companyCode,
        date,
        mergeKey,
        managerId,
      });
      return res.json(out);
    }

    // ✅ TIME-level / ORDER-level HALF cancel
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, message: "orderIds required" });
    }

    const results = [];

    for (const orderId of orderIds) {
      const out = await managerCancelBooking({
        companyCode,
        date,
        time,
        mergeKey,
        orderId,
        managerId,
      });
      results.push(out);
    }

    return res.json({
      ok: true,
      cancelledOrders: orderIds,
      count: orderIds.length,
      results,
    });
  } catch (err) {
    console.error("cancelHalfMerge error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
// --- HALF merge: confirm ---
export async function confirmHalfMerge(req, res) {
  try {
    const { date, time, mergeKey, targetTime, mode } = req.body; 
    // mode optional: "TIME" (default) or "DAY"
    const companyCode = req.user?.companyCode || "VAGR_IT";
    const managerId = req.user?.userId || req.user?.id || "MANAGER";

    if (!date || !mergeKey) {
      return res.status(400).json({ ok: false, message: "date, mergeKey are required" });
    }

    // ✅ DAY-level confirm (blue blink tile)
    if (String(mode || "").toUpperCase() === "DAY") {
      if (!targetTime) {
        return res.status(400).json({ ok: false, message: "targetTime is required for DAY confirm" });
      }

      const out = await managerConfirmDayMerge({
        companyCode,
        date,
        mergeKey,
        targetTime,
        managerId,
      });

      return res.json(out);
    }

    // ✅ TIME-level confirm (orange tile)
    if (!time) {
      delete q.time;
      return res.status(400).json({ ok: false, message: "time is required for TIME confirm" });
    }

    const out = await managerConfirmMerge({
      companyCode,
      date,
      time,
      mergeKey,
      managerId,
    });

    return res.json(out);
  } catch (err) {
    console.error("confirmHalfMerge error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
export async function fetchEligibleHalfBookings({ companyCode, date, time, mergeKey }) {
  const pk = `COMPANY#${companyCode}#DATE#${date}`;

  const statusFilters = ELIGIBLE_STATUSES
    .map((_, i) => `#st = :s${i}`)
    .join(" OR ");

  const filterParts = [
    "#vt = :half",
    "#tm = :tm",
    `(${statusFilters})`,
  ];

  const names = {
    "#pk": "pk",
    "#vt": "vehicleType",
    "#st": "status",
    "#tm": "slotTime",
  };

  const values = {
    ":pk": pk,
    ":half": "HALF",
    ":tm": time,
    ...Object.fromEntries(ELIGIBLE_STATUSES.map((s, i) => [`:s${i}`, s])),
  };

  if (mergeKey) {
    filterParts.push("#mk = :mk");
    names["#mk"] = "mergeKey";
    values[":mk"] = mergeKey;
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "#pk = :pk",
      FilterExpression: filterParts.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );

  return res.Items || [];
}
export async function getEligibleHalfBookingsHandler(req, res) {
  try {
    const { date, time, mergeKey } = req.query;   // ✅ mergeKey added
    const companyCode = req.user?.companyCode || "VAGR_IT";

    if (!date || !time) {
      return res.status(400).json({ ok: false, message: "date and time are required" });
    }

    const bookings = await fetchEligibleHalfBookings({
      companyCode,
      date,
      time,
      mergeKey, // ✅ pass it
    });

    return res.json({ ok: true, count: bookings.length, bookings });
  } catch (err) {
    console.error("getEligibleHalfBookingsHandler error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}

/* ---------------- HELPERS ---------------- */

function findDistributorFromPairingMap(code) {
  if (!code) return null;

  for (const bucket of Object.keys(pairingMap || {})) {
    const list = pairingMap[bucket] || [];
    const found = list.find(
      (d) =>
        String(d.distributorCode || d["Distributor Code"] || "")
          .trim()
          .toUpperCase() === String(code).trim().toUpperCase()
    );
    if (found) return found;
  }
  return null;
}

function extractLatLngFromFinalUrl(url) {
  if (!url) return { lat: null, lng: null };
  const clean = String(url).trim();

  const m1 = clean.match(/\/place\/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (m1) return { lat: Number(m1[1]), lng: Number(m1[3]) };

  const m2 = clean.match(/@(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (m2) return { lat: Number(m2[1]), lng: Number(m2[3]) };

  const m3 = clean.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  if (m3) return { lat: Number(m3[1]), lng: Number(m3[3]) };

  const m4 = clean.match(/[?&]q=(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)/);
  if (m4) return { lat: Number(m4[1]), lng: Number(m4[3]) };

  return { lat: null, lng: null };
}

function validateSlotDate(date) {
  if (!date) throw new Error("date required");

  const today = dayjs().startOf("day");
  const tomorrow = today.add(1, "day");
  const req = dayjs(date, "YYYY-MM-DD").startOf("day");

  if (!req.isSame(today) && !req.isSame(tomorrow)) {
    throw new Error("Slot booking allowed only for today and tomorrow");
  }
}

function sanitizeLatLng(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) < 0.0001) return null;
  return n;
}
function normalizeLocationId(v) {
  if (v === null || v === undefined) return null;

  const s = String(v).trim();
  if (!s) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  const id = String(parseInt(s, 10));
  if (!id || id === "NaN") return null;

  return id;
}

function isPendingOrWaitingStatus(st) {
  const s = String(st || "").toUpperCase();
  return s.includes("PENDING") || s.includes("WAIT");
}

function isConfirmedStatus(st) {
  const s = String(st || "").toUpperCase();
  return s.includes("CONFIRMED") || s === "BOOKED";
}

/* ---------------- Keys ---------------- */

function pkFor(companyCode, date) {
  return `COMPANY#${companyCode}#DATE#${date}`;
}

function skForSlot(time, vehicleType, pos) {
  return `SLOT#${time}#TYPE#${vehicleType}#POS#${pos}`;
}

function skForBooking(time, vehicleType, pos, userId) {
  return `BOOKING#${time}#TYPE#${vehicleType}#POS#${pos}#USER#${userId}`;
}

function skForMergeSlot(time, mergeKey) {
  return `MERGE_SLOT#${time}#KEY#${mergeKey}`;
}

// ✅ NEW: Date-level merge bucket (ignore time)
function skForMergeDay(mergeKey) {
  return `MERGE_DAY#KEY#${mergeKey}`;
}

/* ---------------- RULES ---------------- */

async function getRules(companyCode) {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_RULES,
      Key: { pk: `COMPANY#${companyCode}`, sk: "RULES" },
    })
  );

  const rules = res.Item || {};
return {
  threshold: Number(rules.threshold || DEFAULT_THRESHOLD),
  lastSlotEnabled: Boolean(rules.lastSlotEnabled),
  lastSlotOpenAfter: rules.lastSlotOpenAfter || "17:00",
  slotTimes: rules.slotTimes || DEFAULT_SLOT_TIMES,
};

}

async function updateRules(companyCode, patch) {
  const pk = `COMPANY#${companyCode}`;
  const sk = "RULES";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_RULES,
      Key: { pk, sk },
      UpdateExpression:
        "SET lastSlotEnabled = :e, lastSlotOpenAfter = :oa, updatedAt = :u",
      ExpressionAttributeValues: {
        ":e": Boolean(patch.lastSlotEnabled),
        ":oa": patch.lastSlotOpenAfter || "17:00",
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true };
}

export async function managerSetGlobalMax({ companyCode, maxAmount }) {
  if (!companyCode) throw new Error("companyCode required");

  const pk = `COMPANY#${companyCode}`;
  const sk = "RULES";
  const val = Number(maxAmount || DEFAULT_THRESHOLD);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_RULES,
      Key: { pk, sk },
      UpdateExpression: "SET threshold = :m, updatedAt = :u",
      ExpressionAttributeValues: {
        ":m": val,
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "✅ Threshold Updated", threshold: val };
}

export async function managerToggleLastSlot({
  companyCode,
  enabled,
  openAfter = "17:00",
}) {
  if (!companyCode) throw new Error("companyCode required");

  if (enabled) {
    const nowTime = dayjs().tz(IST_TZ).format("HH:mm");
    if (nowTime < openAfter) {
      throw new Error(`Last slot can be opened only after ${openAfter}`);
    }
  }

  await updateRules(companyCode, {
    lastSlotEnabled: Boolean(enabled),
    lastSlotOpenAfter: openAfter,
  });

  return {
    ok: true,
    message: `✅ Last Slot ${enabled ? "OPENED" : "CLOSED"}`,
    enabled,
    openAfter,
  };
}

export async function managerEnableSlot({
  companyCode,
  date,
  time,
  pos,
  vehicleType = "FULL",
  mergeKey,
}) {
  if (!companyCode || !date || !time)
    throw new Error("companyCode, date, time required");

  const pk = pkFor(companyCode, date);

  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required");
    const slotSk = skForSlot(time, "FULL", pos);

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
        UpdateExpression:
          "SET #s = :avail REMOVE disabledAt, distributorName, distributorCode, orderId, bookedBy",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":avail": "AVAILABLE" },
      })
    );

    return { ok: true, message: "FULL enabled" };
  }

  if (vehicleType === "HALF") {
    if (!mergeKey) throw new Error("mergeKey required");
    const mergeSk2 = skForMergeSlot(time, mergeKey);

    const cap = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } })
    );

    if (cap.Item && String(cap.Item.tripStatus || "").toUpperCase() === "FULL") {
      throw new Error("❌ Already confirmed. Cancel & rebook to change.");
    }

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: mergeSk2 },
        UpdateExpression: "SET tripStatus = :s REMOVE disabledAt",
        ExpressionAttributeValues: { ":s": "PARTIAL" },
      })
    );

    return { ok: true, message: "MERGE enabled" };
  }

  throw new Error("Invalid vehicleType");
}

/* ---------------- SLOT GRID ---------------- */
export async function getSlotGrid({ companyCode, date }) {
  validateSlotDate(date);
  const pk = pkFor(companyCode, date);

  // ---------- CAPACITY ----------
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );
  const overrides = res.Items || [];

  // ---------- BOOKINGS ----------
  const bookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );
  const allBookings = bookingsRes.Items || [];

  // ---------- FULL BOOKING INDEX ----------
  const fullBookingIndex = new Map();
  for (const b of allBookings) {
    if (String(b.vehicleType || "").toUpperCase() !== "FULL") continue;
    const t = String(b.slotTime || "");
    const p = String(b.pos || "");
    if (!t || !p) continue;
    fullBookingIndex.set(`${t}__${p}`, b);
  }

  // ---------- DEFAULT FULL SLOTS ----------
  const rules = await getRules(companyCode);
  const DEFAULT_SLOTS = flattenSlotTimes(rules.slotTimes);
  const NIGHT_SLOTS = rules.slotTimes?.Night || [];

  const defaultSlots = [];
  for (const time of DEFAULT_SLOTS) {
    for (const pos of ALL_POSITIONS) {
      let status = "AVAILABLE";
      if (NIGHT_SLOTS.includes(time) && rules.lastSlotEnabled === false) {
        status = "DISABLED";
      }

      defaultSlots.push({
        pk,
        sk: skForSlot(time, "FULL", pos),
        time,
        vehicleType: "FULL",
        pos,
        status,
      });
    }
  }

  // ---------- FINAL FULL SLOTS ----------
  const finalSlots = defaultSlots.map((slot) => {
    const override = overrides.find((o) => o.sk === slot.sk);
    const merged = override ? { ...slot, ...override } : { ...slot };

    const match = fullBookingIndex.get(
      `${String(merged.time)}__${String(merged.pos)}`
    );

    if (match) {
      merged.status = "BOOKED";
      merged.distributorName = match.distributorName || null;
      merged.distributorCode = match.distributorCode || null;
      merged.orderId = match.orderId || null;
      merged.amount = Number(match.amount || 0);
      merged.bookedBy = match.userId || null;
      merged.userId = merged.userId || match.userId || match.orderId || "BOOKED";
    }

    return merged;
  });
// =========================================================
// 🟠 TIME-LEVEL MERGE SLOTS (STRICT: same time + same location)
// =========================================================
const mergeSlots = overrides
  .filter(
    (o) =>
      String(o.sk || "").startsWith("MERGE_SLOT#") &&
      String(o.tripStatus || "").toUpperCase() !== "FULL"
  )
  .map((m) => {
    let time = m.time || String(m.sk).split("#")[1];
    let mergeKey = m.mergeKey || String(m.sk).split("#KEY#")[1];

    const participants = allBookings.filter(
      (b) =>
        String(b.vehicleType || "").toUpperCase() === "HALF" &&
        String(b.mergeKey || "") === String(mergeKey) &&
        String(b.slotTime || "") === String(time) &&
        isPendingOrWaitingStatus(b.status)
    );

    if (participants.length === 0) return null;

    const totalAmount = participants.reduce(
      (s, b) => s + Number(b.amount || 0),
      0
    );

    const tripStatus =
      participants.length >= 2 && totalAmount >= rules.threshold
        ? "READY_FOR_CONFIRM"
        : participants.length >= 2
        ? "WAITING_MANAGER_CONFIRM"
        : "PARTIAL";

    return {
      ...m,
      time,
      mergeKey,
      vehicleType: "HALF",
      participants: participants.map((b) => ({
        distributorName: b.distributorName,
        distributorCode: b.distributorCode,
        amount: Number(b.amount || 0),
        orderId: b.orderId,
        bookingSk: b.sk,
        lat: b.lat,
        lng: b.lng,
      })),
      bookingCount: participants.length,
      totalAmount,
      tripStatus,
    };
  })
  .filter(Boolean);

  // =========================================================
  // 🔵 DAY-LEVEL MERGE (LOCATION BASED – ONLY)
  // =========================================================
  const dayMergeGroups = overrides
    .filter(
      (o) =>
        String(o.sk || "").startsWith("MERGE_DAY#KEY#")
    )
    .map((d) => {
      const mergeKey =
        d.mergeKey || String(d.sk).split("MERGE_DAY#KEY#")[1];

      const participants = allBookings
        .filter(
          (b) =>
            String(b.vehicleType || "").toUpperCase() === "HALF" &&
            String(b.mergeKey || "") === String(mergeKey) &&
            isPendingOrWaitingStatus(b.status)
        )
        .map((b) => ({
          distributorName: b.distributorName,
          distributorCode: b.distributorCode,
          amount: Number(b.amount || 0),
          orderId: b.orderId,
          bookingSk: b.sk,
          lat: b.lat,
          lng: b.lng,
          slotTime: b.slotTime,
        }));

      // 🧹 delete empty merge cards
      if (participants.length === 0) return null;

      const totalAmount = participants.reduce((s, p) => s + p.amount, 0);

      const tripStatus =
        participants.length >= 2 && totalAmount >= rules.threshold
          ? "READY"
          : participants.length >= 2
          ? "WAITING"
          : "PARTIAL";

      return {
        ...d,
        mergeKey,
        vehicleType: "HALF",
        participants,
        bookingCount: participants.length,
        totalAmount,
        tripStatus,
      };
    })
    .filter(Boolean);

  // ---------- WAITING HALF BOOKINGS ----------
  const waitingHalfBookings = allBookings
    .filter(
      (b) =>
        String(b.vehicleType || "").toUpperCase() === "HALF" &&
        isPendingOrWaitingStatus(b.status)
    )
    .map((b) => ({
      distributorName: b.distributorName,
      distributorCode: b.distributorCode,
      amount: Number(b.amount || 0),
      orderId: b.orderId,
      slotTime: b.slotTime,
      mergeKey: b.mergeKey,
      bookingSk: b.sk,
      lat: b.lat,
      lng: b.lng,
    }));

  // ---------- FINAL RESPONSE ----------
  return {
    slots: [finalSlots,mergeSlots],          // ✅ ONLY FULL SLOTS
    dayMergeGroups,               // ✅ ONLY DAY MERGE
    waitingHalfBookings,
    rules: {
      maxAmount: rules.threshold,
      lastSlotEnabled: rules.lastSlotEnabled,
      lastSlotOpenAfter: rules.lastSlotOpenAfter,
      slotTimes: rules.slotTimes,
    },
  };
}
export async function getAvailableFullTimes({ companyCode, date }) {
  validateSlotDate(date);
  const pk = pkFor(companyCode, date);

  const rules = await getRules(companyCode);
  const DEFAULT_SLOTS = flattenSlotTimes(rules.slotTimes);
  const NIGHT_SLOTS = rules.slotTimes?.Night || [];

  const available = [];

  for (const time of DEFAULT_SLOTS) {
    if (NIGHT_SLOTS.includes(time) && rules.lastSlotEnabled === false) continue;

    for (const pos of ALL_POSITIONS) {
      const sk = skForSlot(time, "FULL", pos);
      const cap = await ddb.send(
        new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk } })
      );

      const st = String(cap.Item?.status || "AVAILABLE").toUpperCase();
      if (st === "AVAILABLE") {
        available.push(time);
        break; // one free pos is enough
      }
    }
  }

  return { ok: true, times: [...new Set(available)] };
}


export async function managerManualMergePickTime({
  companyCode,
  date,
  bookingSks = [],
  targetTime,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !targetTime) {
    throw new Error("companyCode, date, targetTime required");
  }

  if (!Array.isArray(bookingSks) || bookingSks.length < 2) {
    throw new Error("Select at least 2 bookings");
  }

  const pk = pkFor(companyCode, date);

  // 1) Fetch selected bookings
  const bookingItems = [];
  for (const sk of bookingSks) {
    const bRes = await ddb.send(
      new GetCommand({ TableName: TABLE_BOOKINGS, Key: { pk, sk } })
    );
    if (!bRes.Item) throw new Error(`Booking not found: ${sk}`);
    bookingItems.push(bRes.Item);
  }

  // 2) Validate all are HALF + pending/waiting
  for (const b of bookingItems) {
    if (String(b.vehicleType || "").toUpperCase() !== "HALF") {
      throw new Error("Only HALF bookings can be merged");
    }
    if (!isPendingOrWaitingStatus(b.status)) {
      throw new Error("Only PENDING / WAITING bookings allowed");
    }
  }

  // 3) Find AVAILABLE FULL slot in targetTime
  let chosenPos = null;
  for (const p of ALL_POSITIONS) {
    const fullSkTry = skForSlot(targetTime, "FULL", p);

    const capRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: fullSkTry },
      })
    );

    const st = String(capRes?.Item?.status || "AVAILABLE").toUpperCase();
    if (st === "AVAILABLE") {
      chosenPos = p;
      break;
    }
  }

  if (!chosenPos) {
    throw new Error(`No FULL slot available in ${targetTime}`);
  }

  // 4) Total amount + display
  const totalAmount = bookingItems.reduce(
    (sum, b) => sum + Number(b.amount || 0),
    0
  );

  const displayName = bookingItems
    .map((b) => String(b.distributorName || "").trim())
    .filter(Boolean)
    .join(" + ");

  const displayCode =
    String(bookingItems[0].distributorCode || "").trim() || "MERGE";

  const fullOrderId = `ORD_FULL_${uuidv4().slice(0, 8)}`;
  const finalSlotId = `${companyCode}#${date}#${targetTime}#FULL#${chosenPos}`;
  const fullSk = skForSlot(targetTime, "FULL", chosenPos);

  // 5) Transaction: UPDATE capacity (BOOKED) + FULL booking + FULL order
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        // ✅ BOOK capacity slot (always works even if item doesn't exist)
        {
          Update: {
  TableName: TABLE_CAPACITY,
  Key: { pk, sk: fullSk },
  UpdateExpression:
    "SET #s=:b, userId=:uid, #tm=:t, vehicleType=:vt, pos=:p, distributorName=:dn, distributorCode=:dc, orderId=:oid, bookedBy=:m, amount=:a, updatedAt=:u",
  ExpressionAttributeNames: {
    "#s": "status",
    "#tm": "time"
  },
  ExpressionAttributeValues: {
    ":b": "BOOKED",
    ":uid": fullOrderId,
    ":dn": displayName || "MERGE",
    ":dc": displayCode,
    ":oid": fullOrderId,
    ":m": String(managerId || "MANAGER"),
    ":a": totalAmount,
    ":t": targetTime,
    ":p": chosenPos,
    ":vt": "FULL",
    ":u": new Date().toISOString()
  }
},
        },

        // create FULL booking record
        {
          Put: {
            TableName: TABLE_BOOKINGS,
            Item: {
              pk,
              sk: skForBooking(targetTime, "FULL", chosenPos, fullOrderId),
              bookingId: uuidv4(),
              slotTime: targetTime,
              vehicleType: "FULL",
              pos: chosenPos,
              userId: fullOrderId,
              distributorCode: displayCode,
              distributorName: displayName || "MERGE",
              amount: totalAmount,
              orderId: fullOrderId,
              status: "CONFIRMED",
              createdAt: new Date().toISOString(),
            },
          },
        },

        // create FULL order META
        {
          Put: {
            TableName: TABLE_ORDERS,
            Item: {
              pk: `ORDER#${fullOrderId}`,
              sk: "META",
              orderId: fullOrderId,
              companyCode,
              distributorId: displayCode,
              distributorName: displayName || "MERGE",
              mergedOrderIds: bookingItems.map((b) => b.orderId).filter(Boolean),
              slotId: finalSlotId,
              slotDate: date,
              slotTime: targetTime,
              slotVehicleType: "FULL",
              slotPos: chosenPos,
              totalAmount,
              status: "SLOT_BOOKED",
              createdAt: new Date().toISOString(),
              createdBy: String(managerId || "MANAGER"),
            },
          },
        },
      ],
    })
  );
// ✅ CLEANUP: delete old merge capacity records (orange tiles remove guaranteed)
const touched = new Set();

for (const b of bookingItems) {
  const mk = b.mergeKey;
  const t = b.slotTime;
  if (!mk || !t) continue;
  touched.add(`${t}__${mk}`);
}

for (const key of touched) {
  const [t, mk] = key.split("__");
  const mergeSk = skForMergeSlot(t, mk);

  try {
    // mark FULL (optional)
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: mergeSk },
        UpdateExpression: "SET tripStatus=:s, blink=:b, updatedAt=:u",
        ExpressionAttributeValues: {
          ":s": "FULL",
          ":b": false,
          ":u": new Date().toISOString(),
        },
      })
    );

    // ✅ delete override record so it will not appear in grid again
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: mergeSk },
      })
    );
  } catch (_) {}
}
  // 6) Update each HALF booking + each HALF order META
  for (const b of bookingItems) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st=:m, mergedIntoOrderId=:fo, slotVehicleType=:vt, slotTime=:t, slotPos=:p, confirmedAt=:c",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":m": "MERGED",
          ":fo": fullOrderId,
          ":vt": "FULL",
          ":t": targetTime,
          ":p": chosenPos,
          ":c": new Date().toISOString(),
        },
      })
    );

    if (b.orderId) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
          UpdateExpression:
            "SET mergedIntoOrderId=:fo, slotId=:sid, slotVehicleType=:vt, slotPos=:p, tripStatus=:ts, updatedAt=:u",
          ExpressionAttributeValues: {
            ":fo": fullOrderId,
            ":sid": finalSlotId,
            ":vt": "FULL",
            ":p": chosenPos,
            ":ts": "CONFIRMED",
            ":u": new Date().toISOString(),
          }, 
        })
      );
    }
  }
  return {
    ok: true,
    message: "✅ Manual merge completed",
    fullOrderId,
    slotId: finalSlotId,
    targetTime,
    pos: chosenPos,
    mergedBookings: bookingItems.map((b) => b.sk),
  };
}
/* ---------------- ORDERID DUPLICATE CHECK ---------------- */
async function checkOrderAlreadyBooked(pk, orderId) {
  if (!orderId) return false;

  /* =========================
     1️⃣ Read ORDER META
  ========================= */
  const metaRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  const meta = metaRes?.Item;

  // If system itself says not booked → allow booking
  if (!meta || meta.slotBooked !== true) {
    return false;
  }

  /* =========================
     2️⃣ Check BOOKINGS table
     (ignore ORDERLOCK rows)
  ========================= */
  const bookRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const hasRealBooking = (bookRes.Items || []).some(
    (b) =>
      String(b.orderId || "") === String(orderId) &&
      String(b.sk || "").startsWith("BOOKING#") // 👈 IMPORTANT
  );

  if (hasRealBooking) {
    return true;
  }

  /* =========================
     3️⃣ Check CAPACITY table
  ========================= */
  const capRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const hasCapacityLink = (capRes.Items || []).some(
    (c) => String(c.orderId || "") === String(orderId)
  );

  if (hasCapacityLink) {
    return true;
  }

  /* =========================
     ❌ No real booking
     → stale state
  ========================= */
  return false;
}
async function resolveDistributorDetails({
  distributorCode,
  distributorName,
  lat,
  lng,
}) {
  let resolvedName = distributorName || null;
  let resolvedLat = lat ?? null;
  let resolvedLng = lng ?? null;
  let resolvedLocationId = null;
  const excelDist = findDistributorFromPairingMap(distributorCode);
  if (excelDist) {
    if (!resolvedName)
      resolvedName = excelDist.agencyName || excelDist["Agency Name"] || null;
    if (resolvedLat == null || resolvedLat === "") resolvedLat = excelDist.lat;
    if (resolvedLng == null || resolvedLng === "") resolvedLng = excelDist.lng;
      resolvedLocationId = normalizeLocationId(excelDist.locationId || excelDist["Location Id"]);
  }
    try {
      const dist = await getDistributorByCode(distributorCode);

      if (!resolvedName) resolvedName = dist.agencyName || null;
if (!resolvedLocationId) {
      resolvedLocationId = normalizeLocationId(dist.locationId || dist.location_id || dist.location);
    }
      if (resolvedLat == null || resolvedLng == null) {
        const url = dist.final_url || dist.finalUrl || dist.finalURL;
        const parsed = extractLatLngFromFinalUrl(url);
        if (resolvedLat == null) resolvedLat = parsed.lat;
        if (resolvedLng == null) resolvedLng = parsed.lng;
      }
    } catch (_) {}

  const safeLat = sanitizeLatLng(resolvedLat);
  const safeLng = sanitizeLatLng(resolvedLng);

  return { resolvedName, safeLat, safeLng, resolvedLocationId };

}
async function reconcileOrderSlotState({ companyCode, orderId }) {
  if (!orderId) return;

  const metaRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  const meta = metaRes?.Item;
  if (!meta || meta.slotBooked !== true) return;

  const slotDate = meta.slotDate;
  if (!slotDate) return;

  const pk = pkFor(companyCode, slotDate);

  // check real booking rows
  const bookRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const hasBooking = (bookRes.Items || []).some(
    (b) =>
      String(b.orderId || "") === String(orderId) &&
      String(b.sk || "").startsWith("BOOKING#")
  );

  // check capacity
  const capRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const hasCapacity = (capRes.Items || []).some(
    (c) => String(c.orderId || "") === String(orderId)
  );

  // if no real booking → clear stale state
  if (!hasBooking && !hasCapacity) {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_ORDERS,
              Key: { pk: `ORDER#${orderId}`, sk: "META" },
              UpdateExpression:
                "SET slotBooked=:sb, updatedAt=:u " +
                "REMOVE slotId, slotDate, slotTime, slotVehicleType, slotPos, mergeKey, mergedIntoOrderId, tripStatus",
              ExpressionAttributeValues: {
                ":sb": false,
                ":u": new Date().toISOString(),
              },
            },
          },
          {
            Delete: {
              TableName: TABLE_BOOKINGS,
              Key: { pk, sk: `ORDERLOCK#${orderId}` },
            },
          },
        ],
      })
    );
  }
}
export async function bookSlot({
  companyCode,
  date,
  time,
  pos,
  userId,
  distributorCode,
  distributorName,
  amount = 0,
  orderId,
  lat,
  lng,
  locationId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !distributorCode) {
    throw new Error("companyCode, date, time, distributorCode required");
  }

  if (!orderId || String(orderId).trim() === "") {
    throw new Error("❌ orderId required to prevent duplicate booking");
  }

  const pk = pkFor(companyCode, date);

  // ✅ SELF HEAL: stale slotBooked / orderlock clear pannum
  await reconcileOrderSlotState({
    companyCode,
    orderId,
  });

  const rules = await getRules(companyCode);
  const threshold = rules.threshold;
  const NIGHT_SLOTS = rules.slotTimes?.Night || [];

  const uid = userId ? String(userId).trim() : uuidv4();
  const amt = Number(amount || 0);
const { resolvedName, safeLat, safeLng, resolvedLocationId } =
  await resolveDistributorDetails({
    distributorCode,
    distributorName,
    lat,
    lng,
  });
  const vehicleType = amt >= threshold ? "FULL" : "HALF";
  const lockSk = `ORDERLOCK#${orderId}`;

  /* ======================================================
     ✅ FULL BOOKING
  ====================================================== */
  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required for FULL booking");

    // ✅ Night slots closed unless manager enabled
    const NIGHT_SLOTS = rules.slotTimes?.Night || [];
  if (NIGHT_SLOTS.includes(time) && rules.lastSlotEnabled === false) {
    throw new Error("❌ Night slots are closed");
  }
    const slotSk = skForSlot(time, "FULL", pos);
    const bookingSk = skForBooking(time, "FULL", pos, uid);
    const bookingId = uuidv4();

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            // ✅ prevent duplicate booking per order
            {
              Put: {
                TableName: TABLE_BOOKINGS,
                Item: {
                  pk,
                  sk: lockSk,
                  orderId,
                  createdAt: new Date().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },

            // ✅ book capacity slot
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: slotSk },
                ConditionExpression: "attribute_not_exists(#s) OR #s = :avail",
                UpdateExpression:
                  "SET #s = :booked, userId = :uid, distributorName=:dn, distributorCode=:dc, orderId=:oid, bookedBy=:by, amount=:amt",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":avail": "AVAILABLE",
                  ":booked": "BOOKED",
                  ":uid": uid,
                  ":dn": resolvedName,
                  ":dc": distributorCode,
                  ":oid": orderId,
                  ":by": uid,
                  ":amt": amt,
                },
              },
            },

            // ✅ create booking record
            {
              Put: {
                TableName: TABLE_BOOKINGS,
                Item: {
                  pk,
                  sk: bookingSk,
                  bookingId,
                  slotTime: time,
                  vehicleType: "FULL",
                  pos,
                  userId: uid,
                  distributorCode,
                  distributorName: resolvedName,
                  lat: safeLat,
                  lng: safeLng,
                  amount: amt,
                  orderId,
                  status: "CONFIRMED",
                  createdAt: new Date().toISOString(),
                },
              },
            },
          ],
        })
      );
    } catch (e) {
      if (
        String(e.message || "").includes("ConditionalCheckFailed") ||
        String(e.name || "") === "TransactionCanceledException"
      ) {
        throw new Error("❌ This Order already booked a slot (LOCKED)");
      }
      throw e;
    }

    const slotId = `${companyCode}#${date}#${time}#FULL#${pos}`;

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression:
          "SET slotBooked=:sb, slotId=:sid, slotDate=:d, slotTime=:t, slotVehicleType=:vt, slotPos=:p, updatedAt=:u",
        ExpressionAttributeValues: {
          ":sb": true,
          ":sid": slotId,
          ":d": date,
          ":t": time,
          ":vt": "FULL",
          ":p": pos,
          ":u": new Date().toISOString(),
        },
      })
    );

    return {
      ok: true,
      bookingId,
      slotId,
      orderId,
      type: "FULL",
      userId: uid,
      distributorName: resolvedName,
      amount: amt,
      lat: safeLat,
      lng: safeLng,
      slotTime: time,
      date,
      companyCode,
    };
  }
/* ======================================================
   ✅ HALF BOOKING (LOCATIONID BASED MERGE)
====================================================== */

// ✅ Step 0: read order META to fallback locationId / mergeKey
const orderMetaRes = await ddb.send(
  new GetCommand({
    TableName: TABLE_ORDERS,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
  })
);
const orderMeta = orderMetaRes?.Item || {};
let rawLocationId =
  normalizeLocationId(locationId) ||
  normalizeLocationId(orderMeta.locationId) ||
  normalizeLocationId(resolvedLocationId);

// fallback: DB lookup (if still not found)
if (!rawLocationId && distributorCode) {
  try {
    const dist = await getDistributorByCode(distributorCode);
    rawLocationId = normalizeLocationId(dist?.locationId || dist?.location_id || dist?.location);
  } catch (e) {
    console.error("Distributor lookup failed", distributorCode, e);
  }
}

// fallback: old mergeKey
if (!rawLocationId && orderMeta.mergeKey && String(orderMeta.mergeKey).startsWith("LOC#")) {
  rawLocationId = normalizeLocationId(String(orderMeta.mergeKey).split("#")[1]);
}

if (!rawLocationId) {
  throw new Error("❌ locationId missing for distributor");
}
const mergeKey = `LOC#${rawLocationId}`;

// ✅ Step 2: TIME-level merge slot sk + DAY-level sk
const mergeSk = skForMergeSlot(time, mergeKey);      // ex: MERGE#TIME#.. (your helper)
const daySk = skForMergeDay(mergeKey);              // ex: MERGE_DAY#KEY#LOC#2

// ✅ Step 3: block if already confirmed FULL
const mergeCap = await ddb.send(
  new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk } })
);

if (mergeCap.Item && String(mergeCap.Item.tripStatus || "").toUpperCase() === "FULL") {
  throw new Error("❌ This merge is already confirmed. Cancel & rebook.");
}

const blink = true;
const bookingId = uuidv4();
const bookingSk = `BOOKING#${time}#KEY#${mergeKey}#USER#${uid}#${bookingId}`;

try {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        // ✅ lock orderId
        {
          Put: {
            TableName: TABLE_BOOKINGS,
            Item: { pk, sk: lockSk, orderId, createdAt: new Date().toISOString() },
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },

        // ✅ TIME-level merge update (keeps slotTime grouping)
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: mergeSk },
            UpdateExpression:
              "SET totalAmount = if_not_exists(totalAmount,:z)+:a, " +
              "bookingCount = if_not_exists(bookingCount,:z)+:one, " +
              "mergeKey=:mk, locationId=:lid, blink=:b, updatedAt=:u",
            ExpressionAttributeValues: {
              ":z": 0,
              ":one": 1,
              ":a": amt,
              ":mk": mergeKey,
              ":lid": rawLocationId,
              ":b": true,
              ":u": new Date().toISOString(),
            },
          },
        },

        // ✅ DAY-level bucket update (for blink tile ignore time)
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: daySk },
            UpdateExpression:
              "SET totalAmount = if_not_exists(totalAmount,:z)+:a, " +
              "bookingCount = if_not_exists(bookingCount,:z)+:one, " +
              "mergeKey=:mk, locationId=:lid, blink=:b, updatedAt=:u",
            ExpressionAttributeValues: {
              ":z": 0,
              ":one": 1,
              ":a": amt,
              ":mk": mergeKey,
              ":lid": rawLocationId,
              ":b": true,
              ":u": new Date().toISOString(),
            },
          },
        },

        // ✅ booking record
        {
          Put: {
            TableName: TABLE_BOOKINGS,
            Item: {
              pk,
              sk: bookingSk,
              bookingId,
              slotTime: time,
              vehicleType: "HALF",
              userId: uid,
              distributorCode,
              distributorName: resolvedName,
              mergeKey,
              locationId: rawLocationId,
              amount: amt,
              lat: safeLat,
              lng: safeLng,
              orderId,
              status: "PENDING_MANAGER_CONFIRM",
              createdAt: new Date().toISOString(),
            },
          },
        },
      ],
    })
  );
} catch (e) {
  if (
    String(e.message || "").includes("ConditionalCheckFailed") ||
    String(e.name || "") === "TransactionCanceledException"
  ) {
    throw new Error("❌ This Order already booked a slot (LOCKED)");
  }
  throw e;
}

// ✅ update order meta (HALF always slotBooked=false)
await ddb.send(
  new UpdateCommand({
    TableName: TABLE_ORDERS,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression:
      "SET slotBooked=:sb, slotDate=:d, slotTime=:t, slotVehicleType=:vt, " +
      "mergeKey=:mk, locationId=:lid, updatedAt=:u " +
      "REMOVE slotId, slotPos, mergedIntoOrderId, tripStatus",
    ExpressionAttributeValues: {
      ":sb": false,
      ":d": date,
      ":t": time,
      ":vt": "HALF",
      ":mk": mergeKey,
      ":lid": rawLocationId,
      ":u": new Date().toISOString(),
    },
  })
);

// ✅ Compute tripStatus using DAY bucket bookingCount
const dayCap = await ddb.send(
  new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: daySk } })
);

const finalTotal = Number(dayCap?.Item?.totalAmount || 0);
const bookingCount = Number(dayCap?.Item?.bookingCount || 0);
const tripStatus =
  bookingCount >= 2 && finalTotal >= threshold
    ? "READY_FOR_CONFIRM"
    : bookingCount >= 2
    ? "WAITING_MANAGER_CONFIRM"
    : "PARTIAL";
// ✅ SYNC TIME-LEVEL bookingCount when READY
if (tripStatus === "READY_FOR_CONFIRM") {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk }, // TIME-level slot
      UpdateExpression:
        "SET bookingCount=:c, totalAmount=:t, tripStatus=:s, blink=:b, updatedAt=:u",
      ExpressionAttributeValues: {
        ":c": bookingCount,      // 👈 2
        ":t": finalTotal,        // 👈 sum of both
        ":s": tripStatus,
        ":b": true,
        ":u": new Date().toISOString(),
      },
    })
  );
}

// ✅ update both TIME + DAY tripStatus (blink stays true until confirmed/cancel)
await ddb.send(
  new UpdateCommand({
    TableName: TABLE_CAPACITY,
    Key: { pk, sk: mergeSk },
    UpdateExpression: "SET tripStatus=:s, blink=:b, updatedAt=:u",
    ExpressionAttributeValues: {
      ":s": tripStatus,
      ":b": true,
      ":u": new Date().toISOString(),
    },
  })
);

await ddb.send(
  new UpdateCommand({
    TableName: TABLE_CAPACITY,
    Key: { pk, sk: daySk },
    UpdateExpression: "SET tripStatus=:s, blink=:b, updatedAt=:u",
    ExpressionAttributeValues: {
      ":s": tripStatus,
      ":b": true,
      ":u": new Date().toISOString(),
    },
  })
);
return {
  ok: true,
  bookingId,
  type: "HALF",
  tripStatus,
  totalAmount: finalTotal,
  mergeKey,
  blink,
  status: "PENDING_MANAGER_CONFIRM",
  userId: uid,
  distributorName: resolvedName,
};
}
/*Date wise merge*/
export async function getWaitingHalfBookingsByDate(req, res) {
  try {
    const { date } = req.query;
    const companyCode = req.user?.companyCode || "VAGR_IT";

    if (!date) {
      return res.status(400).json({ ok: false, message: "date required" });
    }

    const pk = pkFor(companyCode, date);

    const bookingsRes = await ddb.send(
      new QueryCommand({
        TableName: TABLE_BOOKINGS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
      })
    );

    const all = bookingsRes.Items || [];

    const waiting = all.filter((b) => {
      const vt = String(b.vehicleType || "").toUpperCase();
      return vt === "HALF" && isPendingOrWaitingStatus(b.status);
    });

    return res.json({
      ok: true,
      date,
      count: waiting.length,
      bookings: waiting,
    });
  } catch (e) {
    console.error("getWaitingHalfBookingsByDate", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}
export async function getBlinkGroupsByDateLocation(req, res) {
  try {
    const { date, locationId } = req.query;
    const companyCode = req.user?.companyCode || "VAGR_IT";

    if (!date || !locationId) {
      return res.status(400).json({ ok: false, message: "date, locationId required" });
    }

    const loc = String(parseInt(String(locationId), 10));
    const mergeKey = `LOC#${loc}`;

    const pk = pkFor(companyCode, date);

    const capRes = await ddb.send(
      new QueryCommand({
        TableName: TABLE_CAPACITY,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
      })
    );

    const items = (capRes.Items || []).filter(
      (x) =>
        String(x.sk || "").startsWith("MERGE_DAY#KEY#") &&
        String(x.mergeKey || "") === mergeKey &&
        x.blink === true
    );

    return res.json({ ok: true, date, locationId: loc, count: items.length, groups: items });
  } catch (e) {
    console.error("getBlinkGroupsByDateLocation", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/* ✅ CONFIRM MERGE -> assigns FULL slot + creates FULL master order */
export async function managerConfirmMerge({
  companyCode,
  date,
  time,
  mergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !mergeKey) {
    throw new Error("companyCode, date, time, mergeKey required");
  }

  const rules = await getRules(companyCode);
  const threshold = rules.threshold;

  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeDay(mergeKey);
console.log("🔎 LOOKING FOR MERGE SK:", mergeSk);

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const item = res.Item;
  if (!item) throw new Error("Merge slot not found. Try DAY merge confirm");

  const tripStatus = String(item.tripStatus || "PARTIAL").toUpperCase();
  if (tripStatus === "FULL" || item.confirmedAt) {
    throw new Error("❌ Already confirmed. Cancel & rebook if needed.");
  }

  const total = Number(item.totalAmount || 0);
  if (total < threshold) throw new Error("Not enough amount to confirm");

  // ✅ fetch all HALF bookings
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const bookings = (allBookingsRes.Items || []).filter(
    (b) =>
      String(b.mergeKey || "") === String(mergeKey) &&
      String(b.vehicleType || "").toUpperCase() === "HALF" &&
      isPendingOrWaitingStatus(b.status)
  );

  if (bookings.length < 2) {
    throw new Error("❌ Need at least 2 HALF bookings to confirm");
  }

  // ✅ find available FULL slot
  let chosenPos = null;
  for (const p of ALL_POSITIONS) {
    const slotSk = skForSlot(time, "FULL", p);

    const cap = await ddb.send(
      new GetCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
      })
    );

    const st = String(cap.Item?.status || "AVAILABLE").toUpperCase();
    if (st === "AVAILABLE") {
      chosenPos = p;
      break;
    }
  }

  if (!chosenPos) throw new Error("❌ No FULL slots available");

  const fullSk = skForSlot(time, "FULL", chosenPos);
  const finalSlotId = `${companyCode}#${date}#${time}#FULL#${chosenPos}`;

  // ✅ Display distributor name: "A + B"
  const mergedNames = bookings
  .map((b) => String(b.distributorName || "").trim())
  .filter(Boolean);

const displayName =
  mergedNames.length > 1
    ? mergedNames.join(" + ")
    : mergedNames[0] || "MERGE";


  const displayCode =
    bookings
      .map((b) => String(b.distributorCode || "").trim())
      .filter(Boolean)[0] || "MERGE";
  // ✅ Create FULL master OrderId
  const fullOrderId = `ORD_FULL_${uuidv4().slice(0, 8)}`;
  const mergedOrderIds = bookings.map((b) => String(b.orderId)).filter(Boolean);
  // ✅ Book FULL slot (include amount + orderId also)
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: fullSk },
      ConditionExpression: "attribute_not_exists(#s) OR #s = :avail",
      UpdateExpression:
        "SET #s = :b, userId = :uid, distributorName=:dn, distributorCode=:dc, bookedBy=:m, amount=:amt, orderId=:oid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":avail": "AVAILABLE",
        ":b": "BOOKED",
        ":uid": mergeKey,
        ":dn": displayName,
        ":dc": displayCode,
        ":m": String(managerId || "MANAGER"),
        ":amt": total,
        ":oid": fullOrderId,
      },
    })
  );

  // ✅ Confirm mergeSlot
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression:
        "SET tripStatus = :s, blink = :b, confirmedBy = :m, confirmedAt = :t, pos = :p",
      ExpressionAttributeValues: {
        ":s": "FULL",
        ":b": false,
        ":m": String(managerId || "MANAGER"),
        ":t": new Date().toISOString(),
        ":p": chosenPos,
      },
    })
  );
// 🔥 CLOSE ALL TIME-LEVEL HALF MERGE SLOTS FOR THIS MERGEKEY
const halfMergeSlots = await ddb.send(
  new QueryCommand({
    TableName: TABLE_CAPACITY,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: {
      ":pk": pk,
      ":sk": `MERGE#`, // all merge slots
    },
  })
);

for (const m of halfMergeSlots.Items || []) {
  if (String(m.mergeKey) !== String(mergeKey)) continue;

  // Skip DAY-level merge (already updated)
  if (m.sk === skForMergeDay(mergeKey)) continue;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: m.sk },
      UpdateExpression:
        "SET tripStatus = :s, blink = :b, confirmedAt = :t, confirmedBy = :m",
      ExpressionAttributeValues: {
        ":s": "FULL",
        ":b": false,
        ":t": new Date().toISOString(),
        ":m": String(managerId || "MANAGER"),
      },
    })
  );
}
  // ✅ Create FULL booking record (IMPORTANT FIX for UI)
  const fullBookingSk = skForBooking(time, "FULL", chosenPos, mergeKey);

  await ddb.send(
    new PutCommand({
      TableName: TABLE_BOOKINGS,
      Item: {
        pk,
        sk: fullBookingSk,
        bookingId: uuidv4(),
        slotTime: time,
        vehicleType: "FULL",
        pos: chosenPos,
        userId: mergeKey,
        distributorCode: displayCode,
        distributorName: displayName,
        amount: total,
        orderId: fullOrderId,
        status: "CONFIRMED",
        createdAt: new Date().toISOString(),
      },
    })
  );

  // ✅ create FULL order META
  await ddb.send(
    new PutCommand({
      TableName: TABLE_ORDERS,
      Item: {
        pk: `ORDER#${fullOrderId}`,
        sk: "META",
        orderId: fullOrderId,
        companyCode,
        distributorId: bookings[0].distributorCode,
        distributorName: displayName,
        mergeKey,
        mergedOrderIds,
        slotId: finalSlotId,
        slotDate: date,
        slotTime: time,
        slotVehicleType: "FULL",
        slotPos: chosenPos,
        totalAmount: total,
        status: "SLOT_BOOKED",
        createdAt: new Date().toISOString(),
        createdBy: String(managerId || "MANAGER"),
      },
    })
  );

  // ✅ update each booking + each half order
  for (const b of bookings) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st=:c, confirmedBy=:m, confirmedAt=:t, slotPos=:p, slotVehicleType=:vt, mergedIntoOrderId=:fo",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":m": String(managerId || "MANAGER"),
          ":t": new Date().toISOString(),
          ":p": chosenPos,
          ":vt": "FULL",
          ":fo": fullOrderId,
        },
      })
    );

    if (b.orderId) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
          UpdateExpression:
            "SET mergedIntoOrderId=:fo, slotId=:sid, mergeKey=:mk, slotVehicleType=:vt, slotPos=:p, tripStatus=:ts, updatedAt=:u",
          ExpressionAttributeValues: {
            ":fo": fullOrderId,
            ":sid": finalSlotId,
            ":mk": mergeKey,
            ":vt": "FULL",
            ":p": chosenPos,
            ":ts": "CONFIRMED",
            ":u": new Date().toISOString(),
          },
        })
      );
    }
  }
 // ✅ PASTE THIS HERE
  await markOrderAsMerged({
    fullOrderId,
    childOrderIds: mergedOrderIds,
  });
  // ✅ turn off DATE-level blink also
try {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: skForMergeDay(mergeKey) },
      UpdateExpression: "SET blink=:b, tripStatus=:s, confirmedAt=:t, confirmedBy=:m, updatedAt=:u",
      ExpressionAttributeValues: {
        ":b": false,
        ":s": "FULL",
        ":t": new Date().toISOString(),
        ":m": String(managerId || "MANAGER"),
        ":u": new Date().toISOString(),
      },
    })
  );
} catch (_) {}
  return {
  ok: true,
  mergeKey,
  fullOrderId,
  slotId: finalSlotId,
  totalAmount: total,
  status: "FULL",
  pos: chosenPos,
  mergedOrderIds: mergedOrderIds || [],
  resetOrders: [],
  affectedBookings: bookings.length,
};
}
// ✅ NEW: Confirm DATE-level merge (ignore HALF slotTime; manager chooses targetTime)
export async function managerConfirmDayMerge({
  companyCode,
  date,
  mergeKey,
  targetTime,
  orderIds = [],   // ✅ selected HALF orders
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !mergeKey || !targetTime) {
    throw new Error("companyCode, date, mergeKey, targetTime required");
  }

  if (!Array.isArray(orderIds) || orderIds.length < 2) {
    throw new Error("Select at least 2 orders to confirm");
  }

  const pk = pkFor(companyCode, date);
  const rules = await getRules(companyCode);
  const threshold = Number(rules.threshold || 0);

  // 1️⃣ Load all bookings of date
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  // 2️⃣ Pick ONLY selected HALF orders
  const bookings = (allBookingsRes.Items || []).filter(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "HALF" &&
      String(b.mergeKey || "") === String(mergeKey) &&
      orderIds.includes(String(b.orderId))
  );

  if (bookings.length < 2) {
    throw new Error("Need minimum 2 valid HALF orders");
  }

  const total = bookings.reduce((s, b) => s + Number(b.amount || 0), 0);
  if (total < threshold) throw new Error("Amount below threshold");

  // 3️⃣ Find FREE FULL slot at targetTime
  let chosenPos = null;
  for (const pos of ALL_POSITIONS) {
    const sk = skForSlot(targetTime, "FULL", pos);
    const cap = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk } })
    );
    if (String(cap.Item?.status || "AVAILABLE") === "AVAILABLE") {
      chosenPos = pos;
      break;
    }
  }
  if (!chosenPos) throw new Error("No FULL slot available");

  // 4️⃣ Display names
  const names = bookings.map(b => b.distributorName).filter(Boolean);
  const displayName = names.join(" + ");
  const displayCode = bookings[0].distributorCode || "MERGE";

  // 5️⃣ Create FULL order
  const fullOrderId = `ORD_FULL_${uuidv4().slice(0, 8)}`;
  const slotId = `${companyCode}#${date}#${targetTime}#FULL#${chosenPos}`;

  // 6️⃣ Book FULL capacity
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: skForSlot(targetTime, "FULL", chosenPos) },
      UpdateExpression:
        "SET #s=:b, userId=:u, distributorName=:dn, distributorCode=:dc, orderId=:oid, amount=:a",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":b": "BOOKED",
        ":u": mergeKey,
        ":dn": displayName,
        ":dc": displayCode,
        ":oid": fullOrderId,
        ":a": total,
      },
    })
  );

  // 7️⃣ FULL booking row
  await ddb.send(
    new PutCommand({
      TableName: TABLE_BOOKINGS,
      Item: {
        pk,
        sk: skForBooking(targetTime, "FULL", chosenPos, mergeKey),
        vehicleType: "FULL",
        slotTime: targetTime,
        pos: chosenPos,
        userId: mergeKey,
        distributorName: displayName,
        distributorCode: displayCode,
        amount: total,
        orderId: fullOrderId,
        status: "CONFIRMED",
        createdAt: new Date().toISOString(),
      },
    })
  );

  // 8️⃣ FULL order META
  await ddb.send(
    new PutCommand({
      TableName: TABLE_ORDERS,
      Item: {
        pk: `ORDER#${fullOrderId}`,
        sk: "META",
        orderId: fullOrderId,
        companyCode,
        mergeKey,
        mergedOrderIds: orderIds,
        slotId,
        slotDate: date,
        slotTime: targetTime,
        slotVehicleType: "FULL",
        slotPos: chosenPos,
        totalAmount: total,
        status: "CONFIRMED",
        createdBy: managerId || "MANAGER",
        createdAt: new Date().toISOString(),
      },
    })
  );

  // 9️⃣ Update HALF bookings + orders
  for (const b of bookings) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st=:c, mergedIntoOrderId=:fo, slotTime=:t, slotPos=:p, slotVehicleType=:vt",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":fo": fullOrderId,
          ":t": targetTime,
          ":p": chosenPos,
          ":vt": "FULL",
        },
      })
    );

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
        UpdateExpression:
          "SET mergedIntoOrderId=:fo, tripStatus=:ts, updatedAt=:u",
        ExpressionAttributeValues: {
          ":fo": fullOrderId,
          ":ts": "CONFIRMED",
          ":u": new Date().toISOString(),
        },
      })
    );
  }

  // 🔟 Disable day merge card
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: skForMergeDay(mergeKey) },
      UpdateExpression:
        "SET tripStatus=:s, blink=:b, fullOrderId=:fo",
      ExpressionAttributeValues: {
        ":s": "FULL",
        ":b": false,
        ":fo": fullOrderId,
      },
    })
  );

  return {
    ok: true,
    fullOrderId,
    targetTime,
    pos: chosenPos,
    mergedOrderIds: orderIds,
    affectedBookings: bookings.length,
  };
}
/* ✅ Manual merge */
export async function managerMergeOrdersToMergeKey({
  companyCode,
  date,
  time,
  orderIds = [],
  targetMergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time) {
    throw new Error("companyCode, date, time required");
  }

  if (!Array.isArray(orderIds) || orderIds.length < 2) {
    throw new Error("Provide at least 2 orderIds to merge");
  }

  const pk = pkFor(companyCode, date);
  const rules = await getRules(companyCode);
  const threshold = rules.threshold;

  // 1) Read all bookings of date
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const allBookings = allBookingsRes.Items || [];

  // 2) Select HALF bookings in same time + orderIds + pending/waiting
  const selected = allBookings.filter((b) => {
    const vt = String(b.vehicleType || "").toUpperCase();
    const t = String(b.slotTime || "");
    const oid = String(b.orderId || "");
    return (
      vt === "HALF" &&
      t === String(time) &&
      orderIds.includes(oid) &&
      isPendingOrWaitingStatus(b.status)
    );
  });

  if (selected.length < 2) {
    throw new Error("Not enough PENDING/WATING HALF bookings found for given orderIds");
  }

  // 3) Decide target mergeKey
  let toMergeKey = targetMergeKey;
  if (!toMergeKey || String(toMergeKey).trim() === "") {
    toMergeKey = selected[0].mergeKey || null;
  }
  if (!toMergeKey) {
    throw new Error("targetMergeKey missing and cannot infer from bookings");
  }

  // TIME-level keys
  const toSk = skForMergeSlot(time, toMergeKey);

  // DAY-level keys
  const dayToSk = skForMergeDay(toMergeKey);

  // 4) Prevent merge into already FULL
  const toCap = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: toSk } })
  );

  if (toCap.Item && String(toCap.Item.tripStatus || "").toUpperCase() === "FULL") {
    throw new Error("❌ Target merge already CONFIRMED. Cancel & rebook.");
  }

  // 5) Group selected bookings by their current mergeKey
  const groups = {};
  for (const b of selected) {
    const fromKey = b.mergeKey || "UNKNOWN";
    groups[fromKey] = groups[fromKey] || [];
    groups[fromKey].push(b);
  }

  // 6) Ensure target merge slot exists with mergeKey/lat/lng
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: toSk },
      UpdateExpression:
        "SET mergeKey = if_not_exists(mergeKey, :mk), " +
        "lat = if_not_exists(lat, :lat), lng = if_not_exists(lng, :lng), updatedAt = :u",
      ExpressionAttributeValues: {
        ":mk": toMergeKey,
        ":lat": selected[0].lat ?? null,
        ":lng": selected[0].lng ?? null,
        ":u": new Date().toISOString(),
      },
    })
  );

  let movedTotal = 0;

  // 7) Move each booking's amount from its old mergeKey -> new mergeKey
  for (const fromMergeKey of Object.keys(groups)) {
    if (fromMergeKey === toMergeKey) continue;

    const fromSk = skForMergeSlot(time, fromMergeKey);
    const dayFromSk = skForMergeDay(fromMergeKey);

    const fromCap = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: fromSk } })
    );

    if (fromCap.Item && String(fromCap.Item.tripStatus || "").toUpperCase() === "FULL") {
      throw new Error("❌ Source merge already CONFIRMED. Cancel & rebook.");
    }

    const list = groups[fromMergeKey];

    for (const booking of list) {
      const amt = Number(booking.amount || 0);
      movedTotal += amt;

      // ✅ TRANSACTION: update DAY + TIME + booking mergeKey
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            // (A) DAY-FROM reduce
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: dayFromSk },
                UpdateExpression:
                  "SET totalAmount = if_not_exists(totalAmount,:z) - :a, " +
                  "bookingCount = if_not_exists(bookingCount,:z) - :one, updatedAt = :u",
                ConditionExpression:
                  "if_not_exists(totalAmount,:z) >= :a AND if_not_exists(bookingCount,:z) >= :one",
                ExpressionAttributeValues: {
                  ":z": 0,
                  ":a": amt,
                  ":one": 1,
                  ":u": new Date().toISOString(),
                },
              },
            },

            // (B) DAY-TO add
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: dayToSk },
                UpdateExpression:
                  "SET totalAmount = if_not_exists(totalAmount,:z) + :a, " +
                  "bookingCount = if_not_exists(bookingCount,:z) + :one, " +
                  "mergeKey = if_not_exists(mergeKey,:mk), blink = :b, updatedAt = :u",
                ExpressionAttributeValues: {
                  ":z": 0,
                  ":a": amt,
                  ":one": 1,
                  ":mk": toMergeKey,
                  ":b": true,
                  ":u": new Date().toISOString(),
                },
              },
            },

            // (C) TIME-FROM reduce
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: fromSk },
                UpdateExpression:
                  "SET totalAmount = if_not_exists(totalAmount,:z) - :a, updatedAt = :u",
                ConditionExpression: "if_not_exists(totalAmount,:z) >= :a",
                ExpressionAttributeValues: {
                  ":z": 0,
                  ":a": amt,
                  ":u": new Date().toISOString(),
                },
              },
            },

            // (D) TIME-TO add
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: toSk },
                UpdateExpression:
                  "SET totalAmount = if_not_exists(totalAmount,:z) + :a, " +
                  "mergeKey = if_not_exists(mergeKey,:mk), updatedAt = :u",
                ExpressionAttributeValues: {
                  ":z": 0,
                  ":a": amt,
                  ":mk": toMergeKey,
                  ":u": new Date().toISOString(),
                },
              },
            },

            // (E) Booking mergeKey update
            {
              Update: {
                TableName: TABLE_BOOKINGS,
                Key: { pk, sk: booking.sk },
                UpdateExpression: "SET mergeKey = :mk, movedBy = :m, movedAt = :t",
                ExpressionAttributeValues: {
                  ":mk": toMergeKey,
                  ":m": String(managerId || "MANAGER"),
                  ":t": new Date().toISOString(),
                },
              },
            },
          ],
        })
      );
    }
  }

  // 8) Recompute TIME-level tripStatus
  const cap = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: toSk },
    })
  );

  const finalTotal = Number(cap?.Item?.totalAmount || 0);
  const newTripStatus = finalTotal >= threshold ? "READY_FOR_CONFIRM" : "PARTIAL";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: toSk },
      UpdateExpression: "SET tripStatus = :s, blink = :b, updatedAt = :u",
      ExpressionAttributeValues: {
        ":s": newTripStatus,
        ":b": true,
        ":u": new Date().toISOString(),
      },
    })
  );

  // 9) Recompute DAY-level tripStatus (for blink tiles)
  const dayToRes = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: dayToSk } })
  );

  const dayTotal = Number(dayToRes?.Item?.totalAmount || 0);
  const dayCount = Number(dayToRes?.Item?.bookingCount || 0);

  const dayTripStatus =
    dayCount >= 2 && dayTotal >= threshold
      ? "READY_FOR_CONFIRM"
      : dayCount >= 2
      ? "WAITING_MANAGER_CONFIRM"
      : "PARTIAL";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: dayToSk },
      UpdateExpression: "SET tripStatus=:s, blink=:b, updatedAt=:u",
      ExpressionAttributeValues: {
        ":s": dayTripStatus,
        ":b": true,
        ":u": new Date().toISOString(),
      },
    })
  );

  // 10) Auto confirm after manual merge if READY
  if (newTripStatus === "READY_FOR_CONFIRM") {
    const confirm = await managerConfirmMerge({
      companyCode,
      date,
      time,
      mergeKey: toMergeKey,
      managerId,
    });

    return {
      ok: true,
      message: "✅ Manual merge + Auto Confirm done",
      confirm,
      manualMerged: true,
    };
  }

  return {
    ok: true,
    message: "✅ Orders merged into one MergeKey",
    targetMergeKey: toMergeKey,
    movedCount: selected.length,
    movedTotal,
    finalTotal,
    tripStatus: newTripStatus,
    dayTripStatus,
    dayCount,
    dayTotal,
  };
}
/* ✅ CANCEL CONFIRMED MERGE */
export async function managerCancelConfirmedMerge({
  companyCode,
  date,
  time,
  mergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !mergeKey) {
    throw new Error("companyCode, date, time, mergeKey required");
  }

  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeSlot(time, mergeKey);

  const capRes = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk } })
  );

  const mergeSlot = capRes.Item;
  if (!mergeSlot) throw new Error("Merge slot not found");

  const ts = String(mergeSlot.tripStatus || "").toUpperCase();
  if (ts !== "FULL") {
    throw new Error("❌ Only CONFIRMED (FULL) merge can be cancelled");
  }

  const pos = mergeSlot.pos;
  if (!pos) throw new Error("❌ Confirmed merge missing pos");

  const fullSlotSk = skForSlot(time, "FULL", pos);
const fullCapRes = await ddb.send(
  new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: fullSlotSk } })
);

const fullOrderId = fullCapRes?.Item?.orderId || null;

  // ✅ Fetch all bookings to delete FULL booking safely
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const all = allBookingsRes.Items || [];

  const fullBookings = all.filter(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "FULL" &&
      String(b.slotTime || "") === String(time) &&
      String(b.pos || "") === String(pos)
  );

  const halfBookings = all.filter(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "HALF" &&
      String(b.slotTime || "") === String(time) &&
      String(b.mergeKey || "") === String(mergeKey)
  );

  if (halfBookings.length === 0) {
    throw new Error("No HALF bookings found for this mergeKey");
  }

  // ✅ delete locks for each HALF order
  const lockDeletes = halfBookings
    .map((b) => b.orderId)
    .filter(Boolean)
    .map((oid) => ({
      Delete: {
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: `ORDERLOCK#${oid}` },
      },
    }));

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: fullSlotSk },
            UpdateExpression:
              "SET #s = :avail REMOVE userId, distributorName, distributorCode, bookedBy, orderId",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":avail": "AVAILABLE" },
          },
        },

        // ✅ delete FULL booking record(s)
        ...fullBookings.map((b) => ({
          Delete: {
            TableName: TABLE_BOOKINGS,
            Key: { pk, sk: b.sk },
          },
        })),

        // ✅ reset merge slot
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: mergeSk },
            UpdateExpression:
              "SET tripStatus=:p, blink=:b, updatedAt=:u REMOVE confirmedBy, confirmedAt, userId, pos",
            ExpressionAttributeValues: {
              ":p": "PARTIAL",
              ":b": false,
              ":u": new Date().toISOString(),
            },
          },
        },

        ...lockDeletes,
      ],
    })
  );

  // ✅ reset HALF bookings + reset orders
  for (const b of halfBookings) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st = :p REMOVE confirmedBy, confirmedAt, slotPos, slotVehicleType, mergedIntoOrderId",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":p": "PENDING_MANAGER_CONFIRM" },
      })
    );

    if (b.orderId) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
          UpdateExpression:
            "SET slotBooked=:sb, tripStatus=:ts, updatedAt=:u REMOVE slotPos, slotVehicleType, mergedIntoOrderId",
          ExpressionAttributeValues: {
            ":sb": false,
            ":ts": "PENDING_MANAGER_CONFIRM",
            ":u": new Date().toISOString(),
          },
        })
      );
    }
  }
try {
  await recomputeAndFixMerge({ pk, companyCode, time, mergeKey });
} catch (e) {
  console.error("recomputeAndFixMerge failed:", e);
}
return {
  ok: true,
  message: "✅ Confirmed merge cancelled. Rebook again from start.",
  mergeKey,
  pos,
  cancelledBy: String(managerId || "MANAGER"),
  mergedOrderIds: [],
  resetOrders: [],                 // or mergedOrderIds if you want
  affectedBookings: halfBookings.length,
};
}
/**Day Merge */
export async function managerCancelConfirmedDayMerge({
  companyCode,
  date,
  mergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !mergeKey) {
    throw new Error("companyCode, date, mergeKey required");
  }

  const pk = pkFor(companyCode, date);
  const daySk = skForMergeDay(mergeKey);

  // 1) read day bucket
  const dayRes = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: daySk } })
  );

  const dayItem = dayRes.Item;
  if (!dayItem) throw new Error("Day merge bucket not found");
  if (String(dayItem.tripStatus || "").toUpperCase() !== "FULL") {
    throw new Error("❌ Only CONFIRMED(FULL) can be cancelled");
  }

  // 2) find FULL slot details from confirmed info
  // we stored: confirmedAt, confirmedBy; but FULL slot info not stored in daySk
  // so we must find FULL booking/order by mergedIntoOrderId OR by ORD_FULL in orders
  const fullOrderId = dayItem.fullOrderId || null; // (optional if you store later)

  // safest: scan bookings of date to find FULL booking with userId=mergeKey and orderId=ORD_FULL_*
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const all = allBookingsRes.Items || [];

  const fullBooking = all.find(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "FULL" &&
      String(b.userId || "") === String(mergeKey) &&
      String(b.orderId || "").startsWith("ORD_FULL_")
  );

  if (!fullBooking) throw new Error("FULL booking not found for this mergeKey");

  const time = fullBooking.slotTime;
  const pos = fullBooking.pos;
  const ordFull = fullBooking.orderId;

  const fullSlotSk = skForSlot(time, "FULL", pos);

  // 3) get HALF bookings for this mergeKey (date-wise)
  const halfBookings = all.filter(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "HALF" &&
      String(b.mergeKey || "") === String(mergeKey)
  );

  if (halfBookings.length === 0) throw new Error("No HALF bookings found");

  // 4) transaction: free FULL capacity + delete FULL booking + delete full order meta + unlock/reset half orders
  const transactItems = [
    {
      Update: {
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: fullSlotSk },
        UpdateExpression:
          "SET #s = :avail REMOVE userId, distributorName, distributorCode, orderId, bookedBy, amount",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":avail": "AVAILABLE" },
      },
    },
    {
      Delete: {
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: fullBooking.sk },
      },
    },
    {
      Delete: {
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${ordFull}`, sk: "META" },
      },
    },
    {
      Update: {
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: daySk },
        UpdateExpression:
          "SET tripStatus=:p, blink=:b, updatedAt=:u REMOVE confirmedBy, confirmedAt",
        ExpressionAttributeValues: {
          ":p": "PARTIAL",
          ":b": true,
          ":u": new Date().toISOString(),
        },
      },
    },
  ];

  // reset half bookings + reset their orders + delete ORDERLOCK
  for (const hb of halfBookings) {
    transactItems.push({
      Update: {
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: hb.sk },
        UpdateExpression:
          "SET #st = :p REMOVE confirmedBy, confirmedAt, slotPos, slotVehicleType, mergedIntoOrderId",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":p": "PENDING_MANAGER_CONFIRM" },
      },
    });

    if (hb.orderId) {
      transactItems.push({
        Update: {
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${hb.orderId}`, sk: "META" },
          UpdateExpression:
            "SET slotBooked=:sb, updatedAt=:u " +
            "REMOVE slotId, slotDate, slotTime, slotVehicleType, slotPos, mergeKey, locationId, mergedIntoOrderId, tripStatus",
          ExpressionAttributeValues: {
            ":sb": false,
            ":u": new Date().toISOString(),
          },
        },
      });

      transactItems.push({
        Delete: {
          TableName: TABLE_BOOKINGS,
          Key: { pk, sk: `ORDERLOCK#${hb.orderId}` },
        },
      });
    }
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
return {
  ok: true,
  message: "✅ Day-wise confirmed merge cancelled",
  mergeKey,
  freedSlot: { time, pos },
  cancelledBy: String(managerId || "MANAGER"),
  mergedOrderIds: [],
  resetOrders: [],
  affectedBookings: halfBookings.length,
};
}
/* ✅ CANCEL BOOKING */
export async function managerCancelBooking(payload) {
  let {
    companyCode,
    date,
    time,
    pos,
    userId,
    bookingSk,
    mergeKey,
    orderId,
  } = payload;

  if (!companyCode) throw new Error("companyCode required");
  if (!date) throw new Error("date required");

  // ✅ preserve original orderId (child) that UI clicked
  const originalOrderId = orderId || null;

  // helper: read order meta
  async function readOrderMeta(oid) {
    if (!oid) return null;
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${oid}`, sk: "META" },
      })
    );
    return res?.Item || null;
  }

  /* ======================================================
     ✅ NORMALIZE cancel target:
     - If child has mergedIntoOrderId -> switch to ORD_FULL_*
     - Derive date/time/pos from META (slotDate/slotId)
  ====================================================== */

  let cancelOrderId = orderId || null;

  // 1) if child merged → use master
  if (cancelOrderId && !String(cancelOrderId).startsWith("ORD_FULL_")) {
    const childMeta = await readOrderMeta(cancelOrderId);
    const masterId = childMeta?.mergedIntoOrderId || null;
    if (masterId && String(masterId).startsWith("ORD_FULL_")) {
      cancelOrderId = masterId;
    }
  }

  // 2) read meta (master preferred)
  let meta = await readOrderMeta(cancelOrderId);
  if (!meta && originalOrderId) meta = await readOrderMeta(originalOrderId);

  // 3) derive correct date/time/pos
  if (meta) {
    date = meta.slotDate || date;
    time = time || meta.slotTime || null;
    pos = pos || meta.slotPos || null;

    // Fallback: parse slotId => COMPANY#DATE#TIME#FULL#POS
    if ((!time || !pos) && meta.slotId) {
      const parts = String(meta.slotId).split("#");
      if (!date && parts.length >= 2) date = parts[1];
      if (!time && parts.length >= 3) time = parts[2];
      if (!pos && parts.length >= 5) pos = parts[4];
    }
  }

  // apply normalized cancel order id
  orderId = cancelOrderId;

  // ✅ For HALF cancels, make sure date/time/mergeKey are from ORDER META (prevents pk mismatch)
  if (originalOrderId) {
    const om = await readOrderMeta(originalOrderId);
    if (om) {
      date = om.slotDate || date;
      time = time || om.slotTime || null;
      mergeKey = mergeKey || om.mergeKey || null;
      pos = pos || om.slotPos || null;
    }
  }

  let pk = pkFor(companyCode, date);

  /* =========================
     ✅ FULL cancel
  ========================= */
  const shouldFullCancel = Boolean(time && pos);

  if (shouldFullCancel) {
    const slotSk = skForSlot(time, "FULL", pos);

    const bookingSK = userId ? skForBooking(time, "FULL", pos, userId) : null;

    let resolvedOrderId = orderId || null;

    if (!resolvedOrderId) {
      const capRes = await ddb.send(
        new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: slotSk } })
      );
      resolvedOrderId = capRes?.Item?.orderId || null;
    }

    if (!resolvedOrderId && bookingSK) {
      const bookRes = await ddb.send(
        new GetCommand({ TableName: TABLE_BOOKINGS, Key: { pk, sk: bookingSK } })
      );
      resolvedOrderId = bookRes?.Item?.orderId || null;
    }

    // ✅ if resolved is child -> switch to master if merged
    if (resolvedOrderId && !String(resolvedOrderId).startsWith("ORD_FULL_")) {
      const childMeta = await readOrderMeta(resolvedOrderId);
      const masterId = childMeta?.mergedIntoOrderId || null;
      if (masterId && String(masterId).startsWith("ORD_FULL_")) {
        resolvedOrderId = masterId;
      }
    }

    // ✅ get mergedOrderIds from master meta
    let mergedOrderIds = [];
    if (resolvedOrderId && String(resolvedOrderId).startsWith("ORD_FULL_")) {
      const fullMeta = await readOrderMeta(resolvedOrderId);
      mergedOrderIds = fullMeta?.mergedOrderIds || [];
    }

    // ✅ fallback: at least reset the clicked child order
    if (
      (!Array.isArray(mergedOrderIds) || mergedOrderIds.length === 0) &&
      originalOrderId &&
      !String(originalOrderId).startsWith("ORD_FULL_")
    ) {
      mergedOrderIds = [originalOrderId];
    }

    // ✅ ORD_FULL_* never has a lock, lock is always on customer orders
    const lockSk =
      resolvedOrderId && !String(resolvedOrderId).startsWith("ORD_FULL_")
        ? `ORDERLOCK#${resolvedOrderId}`
        : null;

    const transactItems = [
      {
        Update: {
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: slotSk },
          UpdateExpression:
            "SET #s = :avail REMOVE userId, distributorName, distributorCode, orderId, bookedBy, amount",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":avail": "AVAILABLE" },
        },
      },
    ];

    // delete FULL booking record (resolve if missing)
    let fullBookingSkToDelete = bookingSK;

    if (!fullBookingSkToDelete) {
      const allBookingsRes = await ddb.send(
        new QueryCommand({
          TableName: TABLE_BOOKINGS,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
        })
      );

      const match = (allBookingsRes.Items || []).find(
        (b) =>
          String(b.vehicleType || "").toUpperCase() === "FULL" &&
          String(b.slotTime || "") === String(time) &&
          String(b.pos || "") === String(pos)
      );

      fullBookingSkToDelete = match?.sk || null;
    }

    if (fullBookingSkToDelete) {
      transactItems.push({
        Delete: {
          TableName: TABLE_BOOKINGS,
          Key: { pk, sk: fullBookingSkToDelete },
        },
      });
    }

    if (lockSk) {
      transactItems.push({
        Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: lockSk } },
      });
    }

    // ✅ IMPORTANT: delete clicked child lock also (only if different)
    if (originalOrderId && originalOrderId !== resolvedOrderId) {
      transactItems.push({
        Delete: {
          TableName: TABLE_BOOKINGS,
          Key: { pk, sk: `ORDERLOCK#${originalOrderId}` },
        },
      });
    }

    // reset master order meta if it's a real customer order (not ORD_FULL_*)
    if (resolvedOrderId && !String(resolvedOrderId).startsWith("ORD_FULL_")) {
      transactItems.push({
        Update: {
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${resolvedOrderId}`, sk: "META" },
          UpdateExpression:
            "SET slotBooked=:sb, updatedAt=:u " +
            "REMOVE slotId, slotDate, slotTime, slotVehicleType, slotPos, mergeKey, locationId, mergedIntoOrderId, tripStatus",
          ExpressionAttributeValues: {
            ":sb": false,
            ":u": new Date().toISOString(),
          },
        },
      });
    }

    // ✅ reset child orders + delete their locks
    for (const childId of mergedOrderIds) {
      transactItems.push({
        Update: {
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${childId}`, sk: "META" },
          UpdateExpression:
            "SET slotBooked=:sb, updatedAt=:u " +
            "REMOVE slotId, slotDate, slotTime, slotVehicleType, slotPos, mergeKey, locationId, mergedIntoOrderId, tripStatus",
          ExpressionAttributeValues: {
            ":sb": false,
            ":u": new Date().toISOString(),
          },
        },
      });

      transactItems.push({
        Delete: {
          TableName: TABLE_BOOKINGS,
          Key: { pk, sk: `ORDERLOCK#${childId}` },
        },
      });
    }

    // delete FULL master META (optional)
    if (resolvedOrderId && String(resolvedOrderId).startsWith("ORD_FULL_")) {
      transactItems.push({
        Delete: {
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${resolvedOrderId}`, sk: "META" },
        },
      });
    }
async function recomputeAndFixMerge({ pk, companyCode, time, mergeKey }) {
  const mergeSk2 = skForMergeSlot(time, mergeKey);
  const daySk = skForMergeDay(mergeKey);

  // read all bookings of this date once
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );
  const all = allBookingsRes.Items || [];

  // TIME level half bookings
const timeHalf = all.filter(b =>
  String(b.vehicleType||"").toUpperCase()==="HALF" &&
  String(b.mergeKey||"")===String(mergeKey) &&
  String(b.slotTime||"")===String(time) &&
  isPendingOrWaitingStatus(b.status)
);
  const timeCount = timeHalf.length;
  const timeTotal = timeHalf.reduce((s, b) => s + Number(b.amount || 0), 0);

  // DAY level half bookings
  const dayHalf = all.filter(
    (b) =>
      String(b.vehicleType || "").toUpperCase() === "HALF" &&
      String(b.mergeKey || "") === String(mergeKey)
  );

  const dayCount = dayHalf.length;
  const dayTotal = dayHalf.reduce((s, b) => s + Number(b.amount || 0), 0);

  // ✅ TIME merge cleanup/update
  if (timeCount <= 0 || timeTotal <= 0) {
    try {
      await ddb.send(new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } }));
    } catch (_) {}
  } else {
    const rules = await getRules(companyCode);
    const threshold = Number(rules.threshold || 0);
    const ts = timeTotal >= threshold ? "READY_FOR_CONFIRM" : "PARTIAL";

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: mergeSk2 },
        UpdateExpression:
          "SET totalAmount=:t, bookingCount=:c, tripStatus=:ts, blink=:b, updatedAt=:u",
        ExpressionAttributeValues: {
          ":t": timeTotal,
          ":c": timeCount,
          ":ts": ts,
          ":b": ts === "READY_FOR_CONFIRM",
          ":u": new Date().toISOString(),
        },
      })
    );
  }

  // ✅ DAY merge cleanup/update
  if (dayCount <= 0 || dayTotal <= 0) {
    try {
      await ddb.send(new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: daySk } }));
    } catch (_) {}
  } else {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: daySk },
        UpdateExpression:
          "SET totalAmount=:t, bookingCount=:c, blink=:b, updatedAt=:u",
        ExpressionAttributeValues: {
          ":t": dayTotal,
          ":c": dayCount,
          ":b": true, // day bucket exists -> blink ok (or your own rule)
          ":u": new Date().toISOString(),
        },
      })
    );
  }

  return { timeCount, timeTotal, dayCount, dayTotal };
}

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
await recomputeAndFixMerge({ pk, companyCode, time, mergeKey });

    return {
      ok: true,
      slotType: "FULL",
      orderId: resolvedOrderId,
      date,
      time,
      pos,
      resetOrders: mergedOrderIds,
    };
  }

  /* =========================
     ✅ HALF cancel (resolve bookingSk if missing)
  ========================= */
  let resolvedBookingSk = bookingSk || null;

  if ((!resolvedBookingSk || resolvedBookingSk === "") && mergeKey && originalOrderId) {
    // 1) Try within current pk (fast path)
    const allBookingsRes = await ddb.send(
      new QueryCommand({
        TableName: TABLE_BOOKINGS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
      })
    );

    let candidates = (allBookingsRes.Items || []).filter(
      (b) =>
        String(b.vehicleType || "").toUpperCase() === "HALF" &&
        String(b.mergeKey || "") === String(mergeKey) &&
        String(b.orderId || "") === String(originalOrderId) &&
        (!time || String(b.slotTime || "") === String(time))
    );

    // 2) Fallback: scan by mergeKey+orderId to find the real pk
    if (candidates.length === 0) {
      let lastKey = undefined;
      let found = null;

      do {
        const scanRes = await ddb.send(
          new ScanCommand({
            TableName: TABLE_BOOKINGS,
            ExclusiveStartKey: lastKey,
            Limit: 200,
            FilterExpression: "#vt = :half AND #mk = :mk AND #oid = :oid",
            ExpressionAttributeNames: {
              "#vt": "vehicleType",
              "#mk": "mergeKey",
              "#oid": "orderId",
            },
            ExpressionAttributeValues: {
              ":half": "HALF",
              ":mk": String(mergeKey),
              ":oid": String(originalOrderId),
            },
          })
        );

        found = (scanRes.Items || [])[0] || null;
        lastKey = scanRes.LastEvaluatedKey;
      } while (!found && lastKey);

      if (!found) throw new Error("Booking not found for this orderId");

      pk = found.pk; // ✅ switch to correct pk
      if (!time) time = found.slotTime || null;

      resolvedBookingSk = found.sk;
    } else {
      const match = candidates.sort((a, b) =>
        String(b.createdAt || b.sk || "").localeCompare(String(a.createdAt || a.sk || ""))
      )[0];

      if (!time) time = match.slotTime || null;
      resolvedBookingSk = match.sk;
    }
  }

  if (resolvedBookingSk && mergeKey) {
    if (!time) throw new Error("time required for HALF cancel");

    const mergeSk2 = skForMergeSlot(time, mergeKey);
    const daySk = skForMergeDay(mergeKey);

    const bookingRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: resolvedBookingSk },
      })
    );

    if (!bookingRes.Item) throw new Error("Booking not found");

    const amt = Number(bookingRes.Item.amount || 0);
    const orderIdFromBooking = bookingRes.Item.orderId || null;
    const lockSk = orderIdFromBooking ? `ORDERLOCK#${orderIdFromBooking}` : null;

    const transactItems = [
      // ✅ (FIX-1) TIME-level merge slot: totalAmount + bookingCount decrement
      {
        Update: {
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: mergeSk2 },
          UpdateExpression:
            "SET totalAmount = if_not_exists(totalAmount,:z) - :a, " +
            "bookingCount = if_not_exists(bookingCount,:z) - :one, " +
             "updatedAt = :u REMOVE blink",
          ConditionExpression:
            "attribute_exists(sk)",
          ExpressionAttributeValues: {
            ":z": 0,
            ":a": amt,
            ":one": 1,
            ":u": new Date().toISOString(),
          },
        },
      },

      // ✅ DATE-level bucket decrement
      {
        Update: {
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: daySk },
          UpdateExpression:
            "SET totalAmount = if_not_exists(totalAmount,:z) - :a, " +
            "bookingCount = if_not_exists(bookingCount,:z) - :one, " +
            "updatedAt=:u",
          ConditionExpression:
             "attribute_exists(sk)",
          ExpressionAttributeValues: {
            ":z": 0,
            ":a": amt,
            ":one": 1,
            ":u": new Date().toISOString(),
          },
        },
      },

      // delete booking row
      {
        Delete: {
          TableName: TABLE_BOOKINGS,
          Key: { pk, sk: resolvedBookingSk },
        },
      },
    ];

    if (lockSk) {
      transactItems.push({
        Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: lockSk } },
      });
    }

    if (orderIdFromBooking) {
      transactItems.push({
        Update: {
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${orderIdFromBooking}`, sk: "META" },
          UpdateExpression:
            "SET slotBooked=:sb, updatedAt=:u " +
            "REMOVE slotId, slotDate, slotTime, slotVehicleType, mergeKey, locationId, mergedIntoOrderId, tripStatus, slotPos",
          ExpressionAttributeValues: {
            ":sb": false,
            ":u": new Date().toISOString(),
          },
        },
      });
    }

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

    // recompute TIME-level tripStatus
    const after = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } })
    );

    const rules = await getRules(companyCode);
    const threshold = rules.threshold;

    const finalTotal = Number(after?.Item?.totalAmount || 0);
    const timeBC = Number(after?.Item?.bookingCount || 0);
const newTripStatus =
  timeBC >= 2 && finalTotal >= threshold
    ? "READY_FOR_CONFIRM"
    : timeBC >= 2
    ? "WAITING_MANAGER_CONFIRM"
    : "PARTIAL";

    // if still exists (could be deleted later), update status
    if (after?.Item) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: mergeSk2 },
          UpdateExpression: "SET tripStatus = :s, blink=:b, updatedAt=:u",
          ExpressionAttributeValues: {
            ":s": newTripStatus,
            ":b": newTripStatus === "READY_FOR_CONFIRM",
            ":u": new Date().toISOString(),
          },
        })
      );
    }

    // ✅ read day bucket + if 0 => delete merge cards (FIX-2)
    let dayBC = 0;
    let dayTotal = 0;
    try {
      const dayRes = await ddb.send(
        new GetCommand({
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: daySk },
        })
      );

      dayBC = Number(dayRes?.Item?.bookingCount || 0);
      dayTotal = Number(dayRes?.Item?.totalAmount || 0);

      // blink OFF when empty
      if (dayBC <= 0) {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: daySk },
            UpdateExpression: "SET blink=:b, updatedAt=:u",
            ExpressionAttributeValues: {
              ":b": false,
              ":u": new Date().toISOString(),
            },
          })
        );
      }
    } catch (_) {}

    // ✅ DELETE empty tiles
    // - if time-level merge empty OR day-level empty => remove items so UI won't show orange empty card
    if (finalTotal <= 0 || timeBC <= 0) {
      try {
        await ddb.send(
          new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } })
        );
      } catch (_) {}
    }

    if (dayBC <= 0 || dayTotal <= 0) {
      try {
        await ddb.send(
          new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: daySk } })
        );
      } catch (_) {}
    }

    return {
      ok: true,
      slotType: "HALF",
      orderId: orderIdFromBooking,
      mergeKey,
      time,
      tripStatus: newTripStatus,
      finalTotal,
      timeBookingCount: timeBC,
      dayBookingCount: dayBC,
      mergedOrderIds: [],
      resetOrders: [],
      affectedBookings: 1,
    };
  }

  throw new Error("Invalid cancel payload");
}
/**Delete */
export async function deleteOrderEverywhere({ companyCode, orderId, managerId }) {
  if (!companyCode || !orderId) throw new Error("companyCode, orderId required");

  // 1) read order meta
  const metaRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );
  const meta = metaRes?.Item || null;

  // 2) If order has any booking/merge footprint -> cancel booking first (CASCADE)
  // managerCancelBooking already:
  // - if child merged -> cancels ORD_FULL
  // - frees FULL slot + deletes FULL booking
  // - deletes locks
  // - resets child orders slot fields
  try {
    await managerCancelBooking({
      companyCode,
      date: meta?.slotDate,     // allow null, cancelBooking will derive
      time: meta?.slotTime,
      pos: meta?.slotPos,
      userId: meta?.mergeKey || meta?.userId || null,
      mergeKey: meta?.mergeKey || null,
      orderId,                  // IMPORTANT: pass the deleted orderId
      managerId,
    });
  } catch (e) {
    // If nothing booked, cancelBooking may throw "Invalid cancel payload"
    // We can ignore that and still mark deleted
    const msg = String(e?.message || "");
    if (!msg.includes("Invalid cancel payload") && !msg.includes("Booking not found")) {
      console.error("deleteOrderEverywhere cancelBooking error:", e);
    }
  }

  // 3) Mark THIS order as deleted (global disable)
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression:
        "SET #st=:c, isDeleted=:d, deletedAt=:t, deletedBy=:m, updatedAt=:u",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":c": "CANCELLED",
        ":d": true,
        ":t": new Date().toISOString(),
        ":m": String(managerId || "MANAGER"),
        ":u": new Date().toISOString(),
      },
    })
  );

  // 4) If it was merged into a FULL order -> mark FULL order deleted too (Option-1 rule)
  // (because user expects delete affects whole app)
  const masterId = meta?.mergedIntoOrderId || null;
  if (masterId && String(masterId).startsWith("ORD_FULL_")) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_ORDERS,
        Key: { pk: `ORDER#${masterId}`, sk: "META" },
        UpdateExpression:
          "SET #st=:c, isDeleted=:d, deletedAt=:t, deletedBy=:m, updatedAt=:u",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CANCELLED",
          ":d": true,
          ":t": new Date().toISOString(),
          ":m": String(managerId || "MANAGER"),
          ":u": new Date().toISOString(),
        },
      })
    );
  }

  return { ok: true, message: "✅ Order deleted everywhere", orderId };
}
export const getEligibleHalfBookings = async (q) => {
  const { date, mergeKey, time } = q || {};

  if (!date) throw new Error("date is required");
  if (!mergeKey) throw new Error("mergeKey is required");
  if (!time) throw new Error("time is required");

  const pk = `COMPANY#VAGR_IT#DATE#${date}`;

  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE_BOOKINGS,
      FilterExpression:
        "#pk = :pk AND #vt = :half AND #mk = :mk AND #tm = :tm",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#vt": "vehicleType",
        "#mk": "mergeKey",
        "#tm": "slotTime",
      },
      ExpressionAttributeValues: {
        ":pk": pk,
        ":half": "HALF",
        ":mk": mergeKey,
        ":tm": time,
      },
    })
  );

  return res.Items || [];   // ✅ ONLY ARRAY
};
/* ✅ DISABLE SLOT */
export async function managerDisableSlot({
  companyCode,
  date,
  time,
  pos,
  vehicleType = "FULL",
  mergeKey,
}) {
  if (!companyCode || !date || !time)
    throw new Error("companyCode, date, time required");

  const pk = pkFor(companyCode, date);

  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required for FULL disable");

    const slotSk = skForSlot(time, "FULL", pos);

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
        UpdateExpression: "SET #s = :disabled, disabledAt = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":disabled": "DISABLED",
          ":t": new Date().toISOString(),
        },
      })
    );

    return { ok: true, message: "FULL disabled" };
  }

  if (vehicleType === "HALF") {
    if (!mergeKey) throw new Error("mergeKey required");

    const mergeSk2 = skForMergeSlot(time, mergeKey);

    const cap = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } })
    );
    if (cap.Item && String(cap.Item.tripStatus || "").toUpperCase() === "FULL") {
      throw new Error("❌ Already confirmed. Cancel & rebook to change.");
    }

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: mergeSk2 },
        UpdateExpression: "SET tripStatus = :d, disabledAt = :t",
        ExpressionAttributeValues: {
          ":d": "DISABLED",
          ":t": new Date().toISOString(),
        },
      })
    );

    return { ok: true, message: "MERGE disabled" };
  }

  throw new Error("Invalid vehicleType");
}

/* ✅ SET MERGE SLOT MAX */
export async function managerSetSlotMax({
  companyCode,
  date,
  time,
  mergeKey,
  maxAmount,
}) {
  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeSlot(time, mergeKey);

  const cap = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk } })
  );
  if (cap.Item && String(cap.Item.tripStatus || "").toUpperCase() === "FULL") {
    throw new Error("❌ Already confirmed. Cancel & rebook to change.");
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET maxAmount = :m, updatedAt = :u",
      ExpressionAttributeValues: {
        ":m": Number(maxAmount),
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "Max updated", maxAmount: Number(maxAmount) };
}

/* ✅ EDIT MERGE SLOT TIME */
export async function managerEditSlotTime({
  companyCode,
  date,
  oldTime,
  newTime,
  mergeKey,
}) {
  const pk = pkFor(companyCode, date);

  const oldSk = skForMergeSlot(oldTime, mergeKey);
  const newSk = skForMergeSlot(newTime, mergeKey);

  const oldRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: oldSk },
    })
  );

  if (!oldRes.Item) throw new Error("Old merge slot not found");

  if (String(oldRes.Item.tripStatus || "").toUpperCase() === "FULL") {
    throw new Error("❌ Already confirmed. Cancel & rebook to change.");
  }

  const item = oldRes.Item;

  await ddb.send(
    new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: oldSk } })
  );

  await ddb.send(
    new PutCommand({
      TableName: TABLE_CAPACITY,
      Item: { ...item, sk: newSk, updatedAt: new Date().toISOString() },
    })
  );

  return { ok: true, message: "Time updated", oldTime, newTime };
}

/* ✅ WAITING QUEUE */
export async function joinWaiting({
  companyCode,
  date,
  time,
  userId,
  distributorCode,
  mergeKey,
}) {
  validateSlotDate(date);
  const uid = userId ? String(userId).trim() : uuidv4();

  const pk = `COMPANY#${companyCode}#DATE#${date}#TIME#${time}#BUCKET#${
    mergeKey || "UNKNOWN"
  }`;

  const sk = `WAIT#${new Date().toISOString()}#USER#${uid}`;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_QUEUE,
      Item: {
        pk,
        sk,
        slotTime: time,
        userId: uid,
        distributorCode,
        mergeKey: mergeKey || "UNKNOWN",
        status: "WAITING",
        createdAt: new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "Added to waiting queue" };
}

/* ✅ MANAGER MOVE BOOKING */
export async function managerMoveBookingToMerge({
  companyCode,
  date,
  time,
  bookingSk,
  fromMergeKey,
  toMergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !bookingSk || !fromMergeKey || !toMergeKey) {
    throw new Error("Missing required fields");
  }

  const pk = pkFor(companyCode, date);
  const fromSk = skForMergeSlot(time, fromMergeKey);
  const toSk = skForMergeSlot(time, toMergeKey);

  const [fromCap, toCap] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: fromSk } })),
    ddb.send(new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: toSk } })),
  ]);

  if (fromCap.Item && String(fromCap.Item.tripStatus || "").toUpperCase() === "FULL") {
    throw new Error("❌ Source merge already CONFIRMED. Cancel & rebook.");
  }
  if (toCap.Item && String(toCap.Item.tripStatus || "").toUpperCase() === "FULL") {
    throw new Error("❌ Target merge already CONFIRMED. Cancel & rebook.");
  }

  const bookingRes = await ddb.send(
    new GetCommand({ TableName: TABLE_BOOKINGS, Key: { pk, sk: bookingSk } })
  );
  const booking = bookingRes.Item;
  if (!booking) throw new Error("Booking not found");
  if (isConfirmedStatus(booking.status)) throw new Error("❌ Booking already CONFIRMED. Cancel & rebook.");

  const amt = Number(booking.amount || 0);

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: fromSk },
            UpdateExpression: "SET totalAmount = totalAmount - :a, updatedAt = :u",
            ConditionExpression: "totalAmount >= :a",
            ExpressionAttributeValues: { ":a": amt, ":u": new Date().toISOString() },
          },
        },
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: toSk },
            UpdateExpression: "SET totalAmount = if_not_exists(totalAmount, :z) + :a, updatedAt = :u",
            ExpressionAttributeValues: { ":z": 0, ":a": amt, ":u": new Date().toISOString() },
          },
        },
        {
          Update: {
            TableName: TABLE_BOOKINGS,
            Key: { pk, sk: bookingSk },
            UpdateExpression: "SET mergeKey = :mk, movedBy = :m, movedAt = :t",
            ExpressionAttributeValues: {
              ":mk": toMergeKey,
              ":m": String(managerId || "MANAGER"),
              ":t": new Date().toISOString(),
            },
          },
        },
      ],
    })
  );

  return { ok: true, message: "✅ Booking moved successfully", fromMergeKey, toMergeKey, movedAmount: amt };
}
export async function managerManualCrossSessionMerge({
  companyCode,
  date,
  bookingSk1,
  bookingSk2,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !bookingSk1 || !bookingSk2) {
    throw new Error("companyCode, date, 2 bookingSk required");
  }

  if (bookingSk1 === bookingSk2) {
    throw new Error("Same booking cannot be merged");
  }

  const pk = pkFor(companyCode, date);

  /* 1️⃣ Fetch both bookings */
  const [b1Res, b2Res] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: bookingSk1 },
      })
    ),
    ddb.send(
      new GetCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: bookingSk2 },
      })
    ),
  ]);

  const b1 = b1Res.Item;
  const b2 = b2Res.Item;

  if (!b1 || !b2) throw new Error("Booking not found");

  /* 2️⃣ STRICT VALIDATIONS */
  if (
    String(b1.vehicleType || "").toUpperCase() !== "HALF" ||
    String(b2.vehicleType || "").toUpperCase() !== "HALF"
  ) {
    throw new Error("❌ Only HALF + HALF allowed");
  }

  if (
    !isPendingOrWaitingStatus(b1.status) ||
    !isPendingOrWaitingStatus(b2.status)
  ) {
    throw new Error("❌ Only PENDING / WAITING bookings allowed");
  }

  /* 3️⃣ Decide FINAL SESSION (later time wins) */
  const t1 = dayjs(b1.slotTime, "HH:mm");
  const t2 = dayjs(b2.slotTime, "HH:mm");
  const finalTime = t1.isAfter(t2) ? b1.slotTime : b2.slotTime;

  /* 4️⃣ Find AVAILABLE FULL slot in finalTime (read-only check) */
  let chosenPos = null;

  for (const p of ALL_POSITIONS) {
    const slotSk = skForSlot(finalTime, "FULL", p);

    const cap = await ddb.send(
      new GetCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
      })
    );

    const st = String(cap?.Item?.status || "AVAILABLE").toUpperCase();
    if (st === "AVAILABLE") {
      chosenPos = p;
      break;
    }
  }

  if (!chosenPos) {
    throw new Error(`❌ No FULL slot available in ${finalTime} session`);
  }

  /* 5️⃣ Prepare FULL booking data */
  const totalAmount = Number(b1.amount || 0) + Number(b2.amount || 0);

  const displayName = [b1.distributorName, b2.distributorName]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join(" + ");

  const displayCode =
    String(b1.distributorCode || "").trim() ||
    String(b2.distributorCode || "").trim() ||
    "MERGE";

  const fullOrderId = `ORD_FULL_${uuidv4().slice(0, 8)}`;

  // keep bookingSk unique & deterministic enough
  const fullBookingSk = skForBooking(finalTime, "FULL", chosenPos, fullOrderId);

  const finalSlotId = `${companyCode}#${date}#${finalTime}#FULL#${chosenPos}`;

  /* 6️⃣ TRANSACTION: Book FULL slot + create FULL booking record */
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: skForSlot(finalTime, "FULL", chosenPos) },
            ConditionExpression: "attribute_not_exists(#s) OR #s = :avail",
            UpdateExpression:
              "SET #s=:b, distributorName=:dn, distributorCode=:dc, orderId=:oid, bookedBy=:m, amount=:a",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":avail": "AVAILABLE",
              ":b": "BOOKED",
              ":dn": displayName || "MERGE",
              ":dc": displayCode,
              ":oid": fullOrderId,
              ":m": String(managerId || "MANAGER"),
              ":a": totalAmount,
            },
          },
        },
        {
          Put: {
            TableName: TABLE_BOOKINGS,
            Item: {
              pk,
              sk: fullBookingSk,
              bookingId: uuidv4(),
              slotTime: finalTime,
              vehicleType: "FULL",
              pos: chosenPos,
              userId: fullOrderId,
              distributorCode: displayCode,
              distributorName: displayName || "MERGE",
              amount: totalAmount,
              orderId: fullOrderId,
              status: "CONFIRMED",
              createdAt: new Date().toISOString(),
            },
          },
        },
        // ✅ create FULL order META (so cancel confirmed merge / reporting consistent)
        {
          Put: {
            TableName: TABLE_ORDERS,
            Item: {
              pk: `ORDER#${fullOrderId}`,
              sk: "META",
              orderId: fullOrderId,
              companyCode,
              distributorId: displayCode,
              distributorName: displayName || "MERGE",
              mergedOrderIds: [b1.orderId, b2.orderId].filter(Boolean),
              slotId: finalSlotId,
              slotDate: date,
              slotTime: finalTime,
              slotVehicleType: "FULL",
              slotPos: chosenPos,
              totalAmount,
              status: "SLOT_BOOKED",
              createdAt: new Date().toISOString(),
              createdBy: String(managerId || "MANAGER"),
            },
          },
        },
      ],
    })
  );

  /* 7️⃣ Update BOTH HALF bookings + orders */
  const halfs = [b1, b2];

  for (const b of halfs) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st=:m, mergedIntoOrderId=:fo, slotVehicleType=:vt, slotTime=:t, slotPos=:p, confirmedAt=:c",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":m": "MERGED",
          ":fo": fullOrderId,
          ":vt": "FULL",
          ":t": finalTime,
          ":p": chosenPos,
          ":c": new Date().toISOString(),
        },
      })
    );

    if (b.orderId) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_ORDERS,
          Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
          UpdateExpression:
            "SET mergedIntoOrderId=:fo, slotId=:sid, slotVehicleType=:vt, slotPos=:p, tripStatus=:ts, updatedAt=:u",
          ExpressionAttributeValues: {
            ":fo": fullOrderId,
            ":sid": finalSlotId,
            ":vt": "FULL",
            ":p": chosenPos,
            ":ts": "CONFIRMED",
            ":u": new Date().toISOString(),
          },
        })
      );
    }
  }
  return {
    ok: true,
    message: "✅ Cross-session HALF + HALF merged to FULL",
    fullOrderId,
    slotId: finalSlotId,
    finalSession: finalTime,
    pos: chosenPos,
    mergedBookings: [b1.sk, b2.sk],
  };
}
