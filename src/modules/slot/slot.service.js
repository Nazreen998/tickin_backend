import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

import {
  GetCommand, // ✅ FIXED: Missing Import
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import { pairingMap } from "../../appInit.js";

const TABLE_CAPACITY = "tickin_slot_capacity";
const TABLE_BOOKINGS = "tickin_slot_bookings";
const TABLE_QUEUE = "tickin_slot_waiting_queue";
const TABLE_RULES = "tickin_slot_rules";
const TABLE_TRIPS = "tickin_trips";

const DEFAULT_SLOTS = ["09:00", "12:30", "16:30", "20:30"];
const ALL_POSITIONS = ["A", "B", "C", "D"];

const DEFAULT_MAX_AMOUNT = 80000;

/** Utils */
function pkFor(companyCode, date) {
  return `COMPANY#${companyCode}#DATE#${date}`;
}
function skForSlot(time, vehicleType, pos) {
  return `SLOT#${time}#TYPE#${vehicleType}#POS#${pos}`;
}
function skForBooking(time, vehicleType, pos, userId) {
  return `BOOKING#${time}#TYPE#${vehicleType}#POS#${pos}#USER#${userId}`;
}
function safeKey(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function skForMergeSlot(time, mergeKey) {
  return `MERGE_SLOT#${time}#KEY#${mergeKey}`;
}

/** pairing map resolve */
function findDistributorFromPairingMap(map, distributorCode) {
  const code = String(distributorCode || "").trim();
  if (!code) return { location: null, distributor: null };

  for (const [location, distributors] of Object.entries(map || {})) {
    if (!Array.isArray(distributors)) continue;

    const found = distributors.find((d) => {
      const id = String(d?.distributorId || "").trim();
      const dc = String(d?.distributorCode || "").trim();
      const sk = String(d?.code || "").trim();
      return id === code || dc === code || sk === code;
    });

    if (found) return { location, distributor: found };
  }

  return { location: null, distributor: null };
}

/* ---------------- RULES HELPERS ---------------- */

async function getRule(companyCode) {
  const pk = `COMPANY#${companyCode}`;
  const sk = "RULES";

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_RULES,
      Key: { pk, sk },
    })
  );

  return res.Item || null;
}

async function setRule(companyCode, patch) {
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

/* ---------------- CLUSTER ASSIGNMENTS ---------------- */

async function setClusterAssignment(companyCode, date, orderId, distributorCode, clusterId) {
  const pk = `COMPANY#${companyCode}`;
  const sk = "RULES";

  const rawKey = `${date}_${orderId || ""}_${distributorCode || ""}`;
  const key = safeKey(rawKey);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_RULES,
      Key: { pk, sk },
      UpdateExpression: "SET clusterAssignments.#k = :cid, updatedAt = :u",
      ExpressionAttributeNames: { "#k": key },
      ExpressionAttributeValues: {
        ":cid": String(clusterId),
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true, key, clusterId };
}

/* ✅ THIS EXPORT FIXES YOUR ERROR */
export async function managerAssignCluster({
  companyCode,
  date,
  orderId,
  distributorCode,
  clusterId,
}) {
  return setClusterAssignment(companyCode, date, orderId, distributorCode, clusterId);
}

/* ---------------- SLOT GRID ---------------- */

export async function getSlotGrid({ companyCode, date }) {
  const pk = pkFor(companyCode, date);

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
      defaultSlots.push({
        pk,
        sk: skForSlot(time, "FULL", pos),
        time,
        vehicleType: "FULL",
        pos,
        status: "AVAILABLE",
      });
    }
  }

  const finalSlots = defaultSlots.map((slot) => {
    const override = overrides.find((o) => o.sk === slot.sk);
    return override ? { ...slot, ...override } : slot;
  });

  const mergeSlots = overrides.filter((o) =>
    String(o.sk || "").startsWith("MERGE_SLOT#")
  );

  return [...finalSlots, ...mergeSlots];
}

/* ---------------- MANAGER OPEN LAST SLOT ---------------- */

export async function managerOpenLastSlot({
  companyCode,
  date,
  time = "20:30",
  openAfter = "17:00",
}) {
  const nowTime = dayjs().format("HH:mm");
  if (nowTime < openAfter) {
    throw new Error(`Last slot can be opened only after ${openAfter}`);
  }

  await setRule(companyCode, { lastSlotEnabled: true, lastSlotOpenAfter: openAfter });

  return { ok: true, message: "✅ Last Slot Opened" };
}

/* ---------------- BOOK SLOT ---------------- */

export async function bookSlot({
  companyCode,
  date,
  time,
  pos,
  userId,
  distributorCode,
  amount = 0,
  orderId,
}) {
  const pk = pkFor(companyCode, date);

  const amt = Number(amount || 0);
  const vehicleType = amt >= DEFAULT_MAX_AMOUNT ? "FULL" : "HALF";

  /* ✅ FULL BOOKING */
  if (vehicleType === "FULL") {
    // ✅ FIX: always have a valid uid (even if userId not passed)
    const uid = (userId && String(userId).trim()) ? String(userId).trim() : uuidv4();

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
                ":uid": uid, // ✅ FIXED
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
                vehicleType,
                pos,
                userId: uid, // ✅ FIXED
                distributorCode,
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
        event: "SLOT_BOOKED",
        by: uid, // ✅ FIXED
        extra: { vehicleType: "FULL", time, pos, distributorCode },
      });
    }

    return { ok: true, bookingId, type: "FULL", userId: uid };
  }

  /* ✅ HALF BOOKING (unchanged now, you said later) */
  let { location, distributor } = findDistributorFromPairingMap(pairingMap, distributorCode);

  if (!location) {
    throw new Error(`Distributor location not found for ${distributorCode}`);
  }

  const mergeKey = `LOC#${location}`;
  const mergeSk = skForMergeSlot(time, mergeKey);

  const bookingId = uuidv4();
  const bookingSk = `BOOKING#${time}#KEY#${mergeKey}#USER#${userId}#${bookingId}`;

  const current = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const existing = current.Item || null;
  const currentTotal = Number(existing?.totalAmount || 0);
  const newTotal = currentTotal + amt;
  const tripStatus = newTotal >= DEFAULT_MAX_AMOUNT ? "FULL" : "PARTIAL";

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: mergeSk },
            UpdateExpression:
              "SET totalAmount = :t, tripStatus = :s, mergeKey = :mk, location = :loc",
            ExpressionAttributeValues: {
              ":t": newTotal,
              ":s": tripStatus,
              ":mk": mergeKey,
              ":loc": String(location),
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
              userId,
              distributorCode,
              location: String(location),
              mergeKey,
              amount: amt,
              status: tripStatus,
              createdAt: new Date().toISOString(),
            },
          },
        },
      ],
    })
  );

  return {
    ok: true,
    bookingId,
    type: "HALF",
    tripStatus,
    totalAmount: newTotal,
    mergeKey,
    location,
    distributor,
  };
}

/* ---------------- WAITING QUEUE ---------------- */

export async function joinWaiting({
  companyCode,
  date,
  time,
  userId,
  distributorCode,
}) {
  const pk = `COMPANY#${companyCode}#DATE#${date}#SLOT#${time}`;
  const sk = `WAIT#${new Date().toISOString()}#USER#${userId}`;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_QUEUE,
      Item: {
        pk,
        sk,
        slotTime: time,
        userId,
        distributorCode,
        status: "WAITING",
        createdAt: new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "Added to waiting queue" };
}

/* ---------------- CANCEL SLOT ---------------- */

export async function cancelSlot({ companyCode, date, time, pos, userId }) {
  const pk = pkFor(companyCode, date);
  const slotSk = skForSlot(time, "FULL", pos);
  const bookingSk = skForBooking(time, "FULL", pos, userId);

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: slotSk },
            UpdateExpression: "SET #s = :avail REMOVE userId",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":avail": "AVAILABLE",
            },
          },
        },
        {
          Delete: {
            TableName: TABLE_BOOKINGS,
            Key: { pk, sk: bookingSk },
          },
        },
      ],
    })
  );

  return { ok: true };
}
