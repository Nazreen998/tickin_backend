import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { resolveMergeKeyByRadius, haversineKm } from "./geoMerge.helper.js";
import { pairingMap } from "../../appInit.js";
import { getDistributorByCode } from "../distributors/distributors.service.js";
import { markOrderAsMerged } from "../timeline/timeline.helper.js";

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
export const BUILD_TAG = `slots_fix_${new Date().toISOString()}`;

dayjs.extend(utc);
dayjs.extend(timezone);
const IST_TZ = process.env.APP_TZ || "Asia/Kolkata";

const TABLE_CAPACITY = process.env.TABLE_CAPACITY || "tickin_slot_capacity";
const TABLE_BOOKINGS = process.env.TABLE_BOOKINGS || "tickin_slot_bookings";
const TABLE_QUEUE = process.env.TABLE_QUEUE || "tickin_slot_waiting_queue";
const TABLE_RULES = process.env.TABLE_RULES || "tickin_slot_rules";
const TABLE_ORDERS = process.env.ORDERS_TABLE || "tickin_orders";

const DEFAULT_SLOTS = [
  "09:00", "09:30", "10:00", "10:30",
  "12:00", "12:30", "13:00", "13:30",
  "15:00", "15:30", "16:00", "16:30",
  "18:00", "18:30", "19:00", "19:30",
];

const ALL_POSITIONS = ["A", "B", "C", "D"];
const NIGHT_SLOTS = ["18:00", "18:30", "19:00", "19:30"];

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
];

export async function fetchEligibleHalfBookings({ companyCode, date, time }) {
  const pk = `COMPANY#${companyCode}#DATE#${date}`;
  const skPrefix = `BOOKING#${time}#KEY#`;

  const statusFilters = ELIGIBLE_STATUSES
    .map((_, i) => `#st = :s${i}`)
    .join(" OR ");

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
      FilterExpression: `#vt = :half AND (${statusFilters})`,
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#sk": "sk",
        "#vt": "vehicleType",
        "#st": "status",
      },
      ExpressionAttributeValues: {
        ":pk": pk,
        ":skPrefix": skPrefix,
        ":half": "HALF",
        ...Object.fromEntries(ELIGIBLE_STATUSES.map((s, i) => [`:s${i}`, s])),
      },
    })
  );

  return res.Items || [];
}

export async function getEligibleHalfBookings(req, res) {
  try {
    const { date, time } = req.query;
    const companyCode = req.user?.companyCode || "VAGR_IT";

    if (!date || !time) {
      return res.status(400).json({
        ok: false,
        message: "date and time are required",
      });
    }

    const bookings = await fetchEligibleHalfBookings({
      companyCode,
      date,
      time,
    });

    return res.json({
      ok: true,
      count: bookings.length,
      bookings,
    });
  } catch (err) {
    console.error("getEligibleHalfBookings error:", err);
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

  const rules = await getRules(companyCode);

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );
  const overrides = res.Items || [];

  const bookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );
  const allBookings = bookingsRes.Items || [];

  // ✅ quick index for FULL bookings by time+pos (fast & clean)
  const fullBookingIndex = new Map();
  for (const b of allBookings) {
    if (String(b.vehicleType || "").toUpperCase() !== "FULL") continue;
    const t = String(b.slotTime || "");
    const p = String(b.pos || "");
    if (!t || !p) continue;
    fullBookingIndex.set(`${t}__${p}`, b);
  }

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

  const finalSlots = defaultSlots.map((slot) => {
    // 1) capacity override merge
    const override = overrides.find((o) => o.sk === slot.sk);
    const merged = override ? { ...slot, ...override } : { ...slot };

    // 2) ✅ Source of truth: BOOKINGS table (manual merge writes booking record)
    const match = fullBookingIndex.get(`${String(merged.time)}__${String(merged.pos)}`);

    if (match) {
      merged.status = "BOOKED";
      merged.distributorName = match.distributorName || merged.distributorName || null;
      merged.distributorCode = match.distributorCode || merged.distributorCode || null;
      merged.orderId = match.orderId || merged.orderId || null;
      merged.amount = Number(match?.amount ?? merged?.amount ?? merged?.totalAmount ?? 0);
      merged.bookedBy = match.userId || merged.bookedBy || null;

      // ✅ important for old UI logic / fallback
      merged.userId = merged.userId || match.userId || match.orderId || "BOOKED";
    } else {
      // fallback: old rule (capacity wrote userId but booking record missing)
      if (
        merged.vehicleType === "FULL" &&
        String(merged.status || "").toUpperCase() === "AVAILABLE" &&
        merged.userId
      ) {
        merged.status = "BOOKED";
      }
    }

    return merged;
  });

  const mergeSlots = overrides
    .filter((o) => {
      if (!String(o.sk || "").startsWith("MERGE_SLOT#")) return false;
      const ts = String(o.tripStatus || "").toUpperCase();
      return ts !== "FULL";
    })
    .map((m) => {
      let time = m.time;
      if (!time) {
        try {
          const parts = String(m.sk).split("#");
          if (parts.length > 1) time = parts[1];
        } catch (_) {}
      }

      let mergeKey = m.mergeKey;
      if (!mergeKey) {
        try {
          const sk = String(m.sk || "");
          const parts = sk.split("#KEY#");
          if (parts.length > 1) mergeKey = parts[1];
        } catch (_) {}
      }

      const participants = allBookings
        .filter(
          (b) =>
            String(b.vehicleType || "").toUpperCase() === "HALF" &&
            String(b.slotTime || "") === String(time) &&
            String(b.mergeKey || "") === String(mergeKey)
        )
        .map((b) => ({
          distributorCode: b.distributorCode,
          distributorName: b.distributorName,
          amount: Number(b.amount || 0),
          orderId: b.orderId || null,
          bookingSk: b.sk,
          status: b.status,
          slotTime: b.slotTime,
          mergeKey: b.mergeKey,
          lat: b.lat,
          lng: b.lng,
        }));

      let distanceKm = null;
      if (participants.length >= 2) {
        const a = participants[0];
        const b = participants[1];
        if (a.lat && a.lng && b.lat && b.lng) {
          distanceKm = haversineKm(
            Number(a.lat),
            Number(a.lng),
            Number(b.lat),
            Number(b.lng)
          );
          distanceKm = Number(distanceKm.toFixed(2));
        }
      }

      return {
        ...m,
        time,
        blink: m.blink === true,
        tripStatus: m.tripStatus || "PARTIAL",
        vehicleType: "HALF",
        mergeKey,
        participants,

        canCancel: true,
        canRebook: true,
        canMerge: true,
        orders: participants.map((p) => ({
          orderId: p.orderId,
          distributorName: p.distributorName,
          amount: p.amount,
          bookingSk: p.bookingSk,
        })),

        bookingCount: participants.length,
        distanceKm,
      };
    });

  const waitingHalfBookings = allBookings
    .filter((b) => {
      const vt = String(b.vehicleType || "").toUpperCase();
      return vt === "HALF" && isPendingOrWaitingStatus(b.status);
    })
    .map((b) => ({
      distributorName: b.distributorName,
      distributorCode: b.distributorCode,
      amount: Number(b.amount || 0),
      orderId: b.orderId,
      status: b.status,
      slotTime: b.slotTime,
      mergeKey: b.mergeKey,
      bookingSk: b.sk,
      lat: b.lat,
      lng: b.lng,
    }));

  return {
    slots: [finalSlots, mergeSlots],
    waitingHalfBookings,
    rules: {
      maxAmount: rules.threshold,
      lastSlotEnabled: rules.lastSlotEnabled,
      lastSlotOpenAfter: rules.lastSlotOpenAfter,
    },
  };
}
export async function getAvailableFullTimes({ companyCode, date }) {
  validateSlotDate(date);

  const pk = pkFor(companyCode, date);

  // read capacity table for this date
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const items = res.Items || [];

  const times = [];

  for (const t of DEFAULT_SLOTS) {
    let hasAvailable = false;

    for (const p of ALL_POSITIONS) {
      const sk = skForSlot(t, "FULL", p);
      const found = items.find((x) => x.sk === sk);

      // default is AVAILABLE; override இருந்தா status பார்க்க
      const st = String(found?.status || "AVAILABLE").toUpperCase();

      if (st === "AVAILABLE") {
        hasAvailable = true;
        break;
      }
    }

    if (hasAvailable) times.push(t);
  }

  return { ok: true, date, times };
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
              "SET #s=:b, userId=:uid, time=:t, vehicleType=:vt, pos=:p, distributorName=:dn, distributorCode=:dc, orderId=:oid, bookedBy=:m, amount=:a, updatedAt=:u",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":avail": "AVAILABLE",
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
              ":u": new Date().toISOString(),
            },
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
  for (const key of touched) {
  const [t, mk] = key.split("__");
  const mergeSk = skForMergeSlot(t, mk);

  try {
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
  const t = b.slotTime;
    if (!mk || !t) continue;
    touched.add(`${t}__${mk}`);
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

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const items = res.Items || [];
  return items.some((x) => String(x.orderId || "") === String(orderId));
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

  const excelDist = findDistributorFromPairingMap(distributorCode);
  if (excelDist) {
    if (!resolvedName)
      resolvedName = excelDist.agencyName || excelDist["Agency Name"] || null;
    if (resolvedLat == null || resolvedLat === "") resolvedLat = excelDist.lat;
    if (resolvedLng == null || resolvedLng === "") resolvedLng = excelDist.lng;
  }

  if (resolvedLat == null || resolvedLng == null || !resolvedName) {
    try {
      const dist = await getDistributorByCode(distributorCode);

      if (!resolvedName) resolvedName = dist.agencyName || null;

      if (resolvedLat == null || resolvedLng == null) {
        const url = dist.final_url || dist.finalUrl || dist.finalURL;
        const parsed = extractLatLngFromFinalUrl(url);
        if (resolvedLat == null) resolvedLat = parsed.lat;
        if (resolvedLng == null) resolvedLng = parsed.lng;
      }
    } catch (_) {}
  }

  const safeLat = sanitizeLatLng(resolvedLat);
  const safeLng = sanitizeLatLng(resolvedLng);

  return { resolvedName, safeLat, safeLng };
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

  const already = await checkOrderAlreadyBooked(pk, orderId);
  if (already) throw new Error("❌ This Order already booked a slot");

  const rules = await getRules(companyCode);
  const threshold = rules.threshold;

  const uid = userId ? String(userId).trim() : uuidv4();
  const amt = Number(amount || 0);

  const { resolvedName, safeLat, safeLng } = await resolveDistributorDetails({
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
  let rawLocationId =
    locationId && String(locationId).trim() !== ""
      ? String(locationId).trim()
      : `GEO_${Number(safeLat || 0).toFixed(4)}_${Number(safeLng || 0).toFixed(
          4
        )}`;

  rawLocationId = String(rawLocationId || "").trim();

  // ✅ if purely numeric normalize 01 -> 1
  if (/^\d+$/.test(rawLocationId)) {
    rawLocationId = String(parseInt(rawLocationId, 10));
  }

  // ✅ remove LOC# prefix if present
  rawLocationId = rawLocationId.replace(/^(LOC#)+/i, "").trim();

  const mergeKey = rawLocationId.startsWith("GEO_")
    ? rawLocationId
    : `LOC#${rawLocationId.toUpperCase()}`;

  const mergeSk = skForMergeSlot(time, mergeKey);

  const mergeCap = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk } })
  );

  if (
    mergeCap.Item &&
    String(mergeCap.Item.tripStatus || "").toUpperCase() === "FULL"
  ) {
    throw new Error("❌ This merge is already confirmed. Cancel & rebook.");
  }

  // ✅ get existing HALF bookings for blink
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const alreadyBookings = (allBookingsRes.Items || []).filter(
    (b) =>
      String(b.mergeKey || "") === String(mergeKey) &&
      String(b.slotTime || "") === String(time) &&
      String(b.vehicleType || "").toUpperCase() === "HALF"
  );

  const bookingCountBefore = alreadyBookings.length;
  const blink = bookingCountBefore >= 1;

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
              Item: {
                pk,
                sk: lockSk,
                orderId,
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },

          // ✅ update merge slot amount
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: mergeSk },
              UpdateExpression:
                "SET totalAmount = if_not_exists(totalAmount, :z) + :a, " +
                "mergeKey = :mk, locationId=:lid, lat = :lat, lng = :lng, blink = :b, updatedAt = :u",
              ExpressionAttributeValues: {
                ":z": 0,
                ":a": amt,
                ":mk": mergeKey,
                ":lid": rawLocationId,
                ":lat": safeLat,
                ":lng": safeLng,
                ":b": blink,
                ":u": new Date().toISOString(),
              },
            },
          },

          // ✅ put booking record
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

  const slotId = `${companyCode}#${date}#${time}#HALF#KEY#${mergeKey}`;
await ddb.send(
  new UpdateCommand({
    TableName: TABLE_ORDERS,
    Key: { pk: `ORDER#${orderId}`, sk: "META" },
    UpdateExpression:
      "SET slotBooked=:sb, slotDate=:d, slotTime=:t, slotVehicleType=:vt, mergeKey=:mk, locationId=:lid, updatedAt=:u " +
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
  const updated = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const finalTotal = Number(updated?.Item?.totalAmount || 0);
  const bookingCountAfter = bookingCountBefore + 1;

  const tripStatus =
    bookingCountAfter >= 2 && finalTotal >= threshold
      ? "READY_FOR_CONFIRM"
      : "PARTIAL";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET tripStatus = :s",
      ExpressionAttributeValues: { ":s": tripStatus },
    })
  );

  // ✅ AUTO CONFIRM if READY
  if (tripStatus === "READY_FOR_CONFIRM") {
    try {
      await managerConfirmMerge({
        companyCode,
        date,
        time,
        mergeKey,
        managerId: "AUTO",
      });

      return {
        ok: true,
        bookingId,
        type: "HALF",
        tripStatus: "FULL",
        totalAmount: finalTotal,
        mergeKey,
        blink,
        status: "AUTO_CONFIRMED",
        userId: uid,
        distributorName: resolvedName,
      };
    } catch (e) {
      // keep as pending
    }
  }

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
  const mergeSk = skForMergeSlot(time, mergeKey);

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const item = res.Item;
  if (!item) throw new Error("Merge slot not found");

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
      String(b.slotTime || "") === String(time) &&
      String(b.vehicleType || "").toUpperCase() === "HALF"
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

  return {
    ok: true,
    mergeKey,
    fullOrderId,
    slotId: finalSlotId,
    totalAmount: total,
    status: "FULL",
    pos: chosenPos,
    mergedOrderIds,
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

  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const allBookings = allBookingsRes.Items || [];

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
    throw new Error(
      "Not enough PENDING/WATING HALF bookings found for given orderIds"
    );
  }

  let toMergeKey = targetMergeKey;
  if (!toMergeKey || String(toMergeKey).trim() === "") {
    toMergeKey = selected[0].mergeKey || null;
  }
  if (!toMergeKey) {
    throw new Error("targetMergeKey missing and cannot infer from bookings");
  }

  const toSk = skForMergeSlot(time, toMergeKey);

  const toCap = await ddb.send(
    new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: toSk } })
  );
  if (
    toCap.Item &&
    String(toCap.Item.tripStatus || "").toUpperCase() === "FULL"
  ) {
    throw new Error("❌ Target merge already CONFIRMED. Cancel & rebook.");
  }

  const groups = {};
  for (const b of selected) {
    const fromKey = b.mergeKey || "UNKNOWN";
    groups[fromKey] = groups[fromKey] || [];
    groups[fromKey].push(b);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: toSk },
      UpdateExpression:
        "SET mergeKey = if_not_exists(mergeKey, :mk), " +
        "lat = if_not_exists(lat, :lat), lng = if_not_exists(lng, :lng), updatedAt = :u",
      ExpressionAttributeValues: {
        ":mk": toMergeKey,
        ":lat": selected[0].lat,
        ":lng": selected[0].lng,
        ":u": new Date().toISOString(),
      },
    })
  );

  let movedTotal = 0;

  for (const fromMergeKey of Object.keys(groups)) {
    if (fromMergeKey === toMergeKey) continue;

    const fromSk = skForMergeSlot(time, fromMergeKey);

    const fromCap = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: fromSk } })
    );
    if (
      fromCap.Item &&
      String(fromCap.Item.tripStatus || "").toUpperCase() === "FULL"
    ) {
      throw new Error("❌ Source merge already CONFIRMED. Cancel & rebook.");
    }

    const list = groups[fromMergeKey];

    for (const booking of list) {
      const amt = Number(booking.amount || 0);
      movedTotal += amt;

      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: fromSk },
                UpdateExpression:
                  "SET totalAmount = totalAmount - :a, updatedAt = :u",
                ConditionExpression: "totalAmount >= :a",
                ExpressionAttributeValues: {
                  ":a": amt,
                  ":u": new Date().toISOString(),
                },
              },
            },
            {
              Update: {
                TableName: TABLE_CAPACITY,
                Key: { pk, sk: toSk },
                UpdateExpression:
                  "SET totalAmount = if_not_exists(totalAmount, :z) + :a, updatedAt = :u",
                ExpressionAttributeValues: {
                  ":z": 0,
                  ":a": amt,
                  ":u": new Date().toISOString(),
                },
              },
            },
            {
              Update: {
                TableName: TABLE_BOOKINGS,
                Key: { pk, sk: booking.sk },
                UpdateExpression:
                  "SET mergeKey = :mk, movedBy = :m, movedAt = :t",
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

  const cap = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: toSk },
    })
  );

  const finalTotal = Number(cap?.Item?.totalAmount || 0);
  const newTripStatus =
    finalTotal >= threshold ? "READY_FOR_CONFIRM" : "PARTIAL";

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
  // ✅ Auto confirm after manual merge if READY
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

  return {
    ok: true,
    message: "✅ Confirmed merge cancelled. Rebook again from start.",
    mergeKey,
    pos,
    affectedBookings: halfBookings.length,
    cancelledBy: String(managerId || "MANAGER"),
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

  const pk = pkFor(companyCode, date);
/* =========================
   ✅ FULL cancel (userId optional)
========================= */
if (pos) {
  const slotSk = skForSlot(time, "FULL", pos);

  // ✅ only if userId present
  const bookingSK = userId ? skForBooking(time, "FULL", pos, userId) : null;

  // ✅ resolve orderId (payload OR capacity OR booking)
  let resolvedOrderId = orderId || null;

  // 1) capacity orderId 
  if (!resolvedOrderId) {
    const capRes = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: slotSk } })
    );
    resolvedOrderId = capRes?.Item?.orderId || null;
  }

  // 2) booking record orderId (only if bookingSK exists)
  if (!resolvedOrderId && bookingSK) {
    const bookRes = await ddb.send(
      new GetCommand({ TableName: TABLE_BOOKINGS, Key: { pk, sk: bookingSK } })
    );
    resolvedOrderId = bookRes?.Item?.orderId || null;
  }

  const lockSk = resolvedOrderId ? `ORDERLOCK#${resolvedOrderId}` : null;

  const transactItems = [
    // ✅ free capacity slot
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

  // ✅ delete FULL booking record only if we know bookingSK
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
    Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: fullBookingSkToDelete } },
  });
}
  // ✅ delete order lock
  if (lockSk) {
    transactItems.push({
      Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: lockSk } },
    });
  }

  // ✅ reset order meta (THIS is what enables SLOT button)
  if (resolvedOrderId) {
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

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
if (fullOrderId) {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_ORDERS,
      Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
    })
  );
}
return {
  ok: true,
  slotType: "FULL",
  orderId: resolvedOrderId,
  time,
  pos,
};

}
  /* =========================
     ✅ HALF cancel (resolve bookingSk if missing)
  ========================= */
  let resolvedBookingSk = bookingSk || null;

  // ✅ If bookingSk missing but mergeKey + orderId present, resolve bookingSk by orderId
  if ((!resolvedBookingSk || resolvedBookingSk === "") && mergeKey && orderId) {
    const allBookingsRes = await ddb.send(
      new QueryCommand({
        TableName: TABLE_BOOKINGS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
      })
    );

    const match = (allBookingsRes.Items || []).find(
      (b) =>
        String(b.vehicleType || "").toUpperCase() === "HALF" &&
        String(b.slotTime || "") === String(time) &&
        String(b.mergeKey || "") === String(mergeKey) &&
        String(b.orderId || "") === String(orderId)
    );

    if (!match) throw new Error("Booking not found for this orderId");
    resolvedBookingSk = match.sk;
  }

  /* =========================
     ✅ HALF cancel
  ========================= */
  if (resolvedBookingSk && mergeKey) {
    const mergeSk2 = skForMergeSlot(time, mergeKey);

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
      {
        Update: {
          TableName: TABLE_CAPACITY,
          Key: { pk, sk: mergeSk2 },
          UpdateExpression: "SET totalAmount = totalAmount - :a, updatedAt = :u",
          ConditionExpression: "totalAmount >= :a",
          ExpressionAttributeValues: {
            ":a": amt,
            ":u": new Date().toISOString(),
          },
        },
      },
      {
        Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: resolvedBookingSk } },
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

    // ✅ Recompute tripStatus after cancel
    const after = await ddb.send(
      new GetCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: mergeSk2 } })
    );

    const rules = await getRules(companyCode);
    const threshold = rules.threshold;

    const finalTotal = Number(after?.Item?.totalAmount || 0);
    const newTripStatus =
      finalTotal >= threshold ? "READY_FOR_CONFIRM" : "PARTIAL";

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
return {
  ok: true,
  slotType: "HALF",
  orderId: orderIdFromBooking,
  mergeKey,
  time,
  tripStatus: newTripStatus,
  finalTotal,
};
  }

  throw new Error("Invalid cancel payload");
}
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

