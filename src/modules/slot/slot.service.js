import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { resolveMergeKeyByRadius } from "./geoMerge.helper.js";
import { pairingMap } from "../../appInit.js";
import { getDistributorByCode } from "../distributors/distributors.service.js";

import {
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
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


const DEFAULT_SLOTS = ["09:00", "12:30", "16:00", "20:00"];
const ALL_POSITIONS = ["A", "B", "C", "D"];

const DEFAULT_THRESHOLD = Number(process.env.DEFAULT_MAX_AMOUNT || 80000);
const MERGE_RADIUS_KM = Number(process.env.MERGE_RADIUS_KM || 25);

const LAST_SLOT_TIME = "20:00";

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
export async function managerToggleLastSlot({ companyCode, enabled, openAfter = "17:00" }) {
  if (!companyCode) throw new Error("companyCode required");

  if (enabled) {
    const nowTime = dayjs().tz(IST_TZ).format("HH:mm");  // ✅ IST based
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
export async function managerEnableSlot({ companyCode, date, time, pos, vehicleType = "FULL", mergeKey }) {
  if (!companyCode || !date || !time) throw new Error("companyCode, date, time required");
  const pk = pkFor(companyCode, date);

  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required");
    const slotSk = skForSlot(time, "FULL", pos);

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
        UpdateExpression: "SET #s = :avail REMOVE disabledAt",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":avail": "AVAILABLE" },
      })
    );

    return { ok: true, message: "FULL enabled" };
  }

  if (vehicleType === "HALF") {
    if (!mergeKey) throw new Error("mergeKey required");
    const mergeSk2 = skForMergeSlot(time, mergeKey);

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

  const defaultSlots = [];
  for (const time of DEFAULT_SLOTS) {
    for (const pos of ALL_POSITIONS) {
      let status = "AVAILABLE";
      if (time === LAST_SLOT_TIME && rules.lastSlotEnabled === false) {
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
    const override = overrides.find((o) => o.sk === slot.sk);
    return override ? { ...slot, ...override } : slot;
  });

  const mergeSlots = overrides
    .filter((o) => String(o.sk || "").startsWith("MERGE_SLOT#"))
    .map((m) => ({
      ...m,
      blink: m.blink === true,
      tripStatus: m.tripStatus || "PARTIAL",
      vehicleType: "HALF",
    }));

  return {
    slots: [...finalSlots, ...mergeSlots],
    rules: {
      maxAmount: rules.threshold,
      lastSlotEnabled: rules.lastSlotEnabled,
      lastSlotOpenAfter: rules.lastSlotOpenAfter,
    },
  };
}
function sanitizeLatLng(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  // treat (0,0) invalid
  if (Math.abs(n) < 0.0001) return null;

  return n;
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

/* ✅ COMMON RESOLVER */
async function resolveDistributorDetails({ distributorCode, distributorName, lat, lng }) {
  let resolvedName = distributorName || null;
  let resolvedLat = lat ?? null;
  let resolvedLng = lng ?? null;

  const excelDist = findDistributorFromPairingMap(distributorCode);
  if (excelDist) {
    if (!resolvedName) {
      resolvedName = excelDist.agencyName || excelDist["Agency Name"] || null;
    }
    if (resolvedLat == null || resolvedLat === "") resolvedLat = excelDist.lat;
    if (resolvedLng == null || resolvedLng === "") resolvedLng = excelDist.lng;
  }

  // fallback from distributors table
  if (resolvedLat == null || resolvedLng == null || !resolvedName) {
    try {
      const dist = await getDistributorByCode(distributorCode);

      if (!resolvedName) resolvedName = dist.agencyName || dist.distributorName || null;

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
/* ---------------- BOOK SLOT ---------------- */
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
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !distributorCode) {
    throw new Error("companyCode, date, time, distributorCode required");
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

  /* ✅ FULL */
  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required for FULL booking");
    if (time === LAST_SLOT_TIME && rules.lastSlotEnabled === false) {
      throw new Error("❌ Last slot is closed");
    }

    const slotSk = skForSlot(time, "FULL", pos);
    const bookingSk = skForBooking(time, "FULL", pos, uid);
    const bookingId = uuidv4();

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: slotSk },
              ConditionExpression: "attribute_not_exists(#s) OR #s = :avail",
              UpdateExpression: "SET #s = :booked, userId = :uid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":avail": "AVAILABLE",
                ":booked": "BOOKED",
                ":uid": uid,
              },
            },
          },
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

    if (orderId) {
      await addTimelineEvent({
        orderId,
        event: "SLOT_BOOKED_FULL",
        by: uid,
        role: "BOOKING",
        data: { vehicleType: "FULL", time, pos, distributorCode, distributorName: resolvedName, lat: safeLat, lng: safeLng },
      });
    }

    return { ok: true, bookingId, type: "FULL", userId: uid, distributorName: resolvedName, lat: safeLat, lng: safeLng };
  }

  /* ✅ HALF (GEO MERGE) */
  if (safeLat == null || safeLng == null) {
    throw new Error("❌ lat/lng missing. Distributor final_url not available");
  }

  const capRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const existingMergeSlots = (capRes.Items || []).filter((x) =>
    String(x.sk || "").startsWith(`MERGE_SLOT#${time}#`)
  );

  const geo = resolveMergeKeyByRadius(existingMergeSlots, safeLat, safeLng, MERGE_RADIUS_KM);

  const mergeKey = geo.mergeKey;
  const blink = geo.blink;

  const mergeSk = skForMergeSlot(time, mergeKey);
  const bookingId = uuidv4();
  const bookingSk = `BOOKING#${time}#KEY#${mergeKey}#USER#${uid}#${bookingId}`;

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: mergeSk },
            UpdateExpression:
              "SET totalAmount = if_not_exists(totalAmount, :z) + :a, " +
              "mergeKey = :mk, lat = :lat, lng = :lng, blink = :b, updatedAt = :u",
            ExpressionAttributeValues: {
              ":z": 0,
              ":a": amt,
              ":mk": mergeKey,
              ":lat": safeLat,
              ":lng": safeLng,
              ":b": Boolean(blink),
              ":u": new Date().toISOString(),
            },
          },
        },
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

  const updated = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const finalTotal = Number(updated?.Item?.totalAmount || 0);
  const tripStatus = finalTotal >= threshold ? "READY_FOR_CONFIRM" : "PARTIAL";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET tripStatus = :s",
      ExpressionAttributeValues: { ":s": tripStatus },
    })
  );

  if (orderId) {
    await addTimelineEvent({
      orderId,
      event: "SLOT_BOOKED_PARTIAL",
      by: uid,
      role: "BOOKING",
      data: { vehicleType: "HALF", time, mergeKey, distributorCode, distributorName: resolvedName, lat: safeLat, lng: safeLng, tripStatus, amount: amt, totalAmount: finalTotal, blink },
    });
  }

  return { ok: true, bookingId, type: "HALF", tripStatus, totalAmount: finalTotal, mergeKey, blink, status: "PENDING_MANAGER_CONFIRM", userId: uid, lat: safeLat, lng: safeLng, distributorName: resolvedName };
}

/* ✅ CONFIRM MERGE */
export async function managerConfirmMerge({ companyCode, date, time, mergeKey, managerId }) {
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

  const total = Number(item.totalAmount || 0);
  if (total < threshold) throw new Error("Not enough amount to confirm");

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET tripStatus = :s, confirmedBy = :m, confirmedAt = :t",
      ExpressionAttributeValues: {
        ":s": "CONFIRMED",
        ":m": String(managerId || "MANAGER"),
        ":t": new Date().toISOString(),
      },
    })
  );

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

  for (const b of bookings) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression: "SET #s = :c, confirmedAt = :t, confirmedBy = :m",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":t": new Date().toISOString(),
          ":m": String(managerId || "MANAGER"),
        },
      })
    );
  }

  return { ok: true, mergeKey, totalAmount: total, status: "CONFIRMED" };
}

/* ✅ CANCEL BOOKING */
export async function managerCancelBooking({ companyCode, date, time, pos, userId, bookingSk, mergeKey }) {
  const pk = pkFor(companyCode, date);

  // FULL cancel
  if (pos && userId) {
    const slotSk = skForSlot(time, "FULL", pos);
    const bookingSK = skForBooking(time, "FULL", pos, userId);

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: slotSk },
              UpdateExpression: "SET #s = :avail REMOVE userId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":avail": "AVAILABLE" },
            },
          },
          {
            Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: bookingSK } },
          },
        ],
      })
    );

    return { ok: true, type: "FULL" };
  }

  // HALF cancel
  if (bookingSk && mergeKey) {
    const mergeSk2 = skForMergeSlot(time, mergeKey);

    const bookingRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: bookingSk },
      })
    );

    if (!bookingRes.Item) throw new Error("Booking not found");
    const amt = Number(bookingRes.Item.amount || 0);

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
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
            Delete: { TableName: TABLE_BOOKINGS, Key: { pk, sk: bookingSk } },
          },
        ],
      })
    );

    return { ok: true, type: "HALF" };
  }

  throw new Error("Invalid cancel payload");
}

/* ✅ DISABLE SLOT */
export async function managerDisableSlot({ companyCode, date, time, pos, vehicleType = "FULL", mergeKey }) {
  if (!companyCode || !date || !time) throw new Error("companyCode, date, time required");
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
export async function managerSetSlotMax({ companyCode, date, time, mergeKey, maxAmount }) {
  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeSlot(time, mergeKey);

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
export async function managerEditSlotTime({ companyCode, date, oldTime, newTime, mergeKey }) {
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
  const item = oldRes.Item;

  await ddb.send(new DeleteCommand({ TableName: TABLE_CAPACITY, Key: { pk, sk: oldSk } }));

  await ddb.send(
    new PutCommand({
      TableName: TABLE_CAPACITY,
      Item: { ...item, sk: newSk, updatedAt: new Date().toISOString() },
    })
  );

  return { ok: true, message: "Time updated", oldTime, newTime };
}

/* ✅ WAITING QUEUE */
export async function joinWaiting({ companyCode, date, time, userId, distributorCode, mergeKey }) {
  validateSlotDate(date);
  const uid = userId ? String(userId).trim() : uuidv4();

  const pk = `COMPANY#${companyCode}#DATE#${date}#TIME#${time}#BUCKET#${mergeKey || "UNKNOWN"}`;
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
/* ---------------- MANAGER MOVE BOOKING TO ANOTHER MERGE ---------------- */
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

  // ✅ get booking
  const bookingRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_BOOKINGS,
      Key: { pk, sk: bookingSk },
    })
  );

  const booking = bookingRes.Item;
  if (!booking) throw new Error("Booking not found");

  const amt = Number(booking.amount || 0);

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        // ✅ reduce from merge
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: fromSk },
            UpdateExpression: "SET totalAmount = totalAmount - :a, updatedAt = :u",
            ConditionExpression: "totalAmount >= :a",
            ExpressionAttributeValues: {
              ":a": amt,
              ":u": new Date().toISOString(),
            },
          },
        },

        // ✅ add to merge
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: toSk },
            UpdateExpression: "SET totalAmount = if_not_exists(totalAmount, :z) + :a, updatedAt = :u",
            ExpressionAttributeValues: {
              ":z": 0,
              ":a": amt,
              ":u": new Date().toISOString(),
            },
          },
        },

        // ✅ update booking mergeKey
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

  return { ok: true, fromMergeKey, toMergeKey, movedAmount: amt };
}
