import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

import {
  GetCommand,
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
  if (!companyCode || !date || !time || !distributorCode) {
    throw new Error("companyCode, date, time, distributorCode required");
  }

  const pk = pkFor(companyCode, date);
  const uid = (userId && String(userId).trim()) ? String(userId).trim() : uuidv4();

  const amt = Number(amount || 0);
  const vehicleType = amt >= DEFAULT_MAX_AMOUNT ? "FULL" : "HALF";

  /* ✅ FULL BOOKING */
  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required for FULL booking");

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
        event: "SLOT_BOOKED",
        by: uid,
        extra: { vehicleType: "FULL", time, pos, distributorCode },
      });
    }

    return { ok: true, bookingId, type: "FULL", userId: uid };
  }

  /* ✅ HALF BOOKING (Manager confirmation flow) */
  let { location, distributor } = findDistributorFromPairingMap(pairingMap, distributorCode);
  if (!location) location = "UNKNOWN";

  const mergeKey = `LOC#${location}`;
  const mergeSk = skForMergeSlot(time, mergeKey);

  const bookingId = uuidv4();
  const bookingSk = `BOOKING#${time}#KEY#${mergeKey}#USER#${uid}#${bookingId}`;

  // ✅ Safe transact update
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: mergeSk },
            UpdateExpression:
              "SET totalAmount = if_not_exists(totalAmount, :z) + :a, " +
              "mergeKey = :mk, location = :loc, updatedAt = :u",
            ExpressionAttributeValues: {
              ":z": 0,
              ":a": amt,
              ":mk": mergeKey,
              ":loc": String(location),
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
              location: String(location),
              mergeKey,
              amount: amt,
              orderId,
              status: "PENDING_MANAGER_CONFIRM",
              createdAt: new Date().toISOString(),
            },
          },
        },
      ],
    })
  );

  // ✅ Read back total
  const updated = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const finalTotal = Number(updated?.Item?.totalAmount || 0);
  const tripStatus = finalTotal >= DEFAULT_MAX_AMOUNT ? "READY_FOR_CONFIRM" : "PARTIAL";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET tripStatus = :s",
      ExpressionAttributeValues: { ":s": tripStatus },
    })
  );

  if (tripStatus === "READY_FOR_CONFIRM") {
    await addTimelineEvent({
      orderId: orderId || bookingId,
      event: "MERGE_READY_MANAGER_CONFIRM",
      by: uid,
      extra: { mergeKey, location, totalAmount: finalTotal, time, distributorCode },
    });
  }

  return {
    ok: true,
    bookingId,
    type: "HALF",
    tripStatus,
    totalAmount: finalTotal,
    mergeKey,
    location,
    distributor,
    status: "PENDING_MANAGER_CONFIRM",
    userId: uid,
  };
}

/* ---------------- MANAGER CONFIRM MERGE ---------------- */

export async function managerConfirmMerge({
  companyCode,
  date,
  time,
  mergeKey,
  managerId,
}) {
  if (!companyCode || !date || !time || !mergeKey) {
    throw new Error("companyCode, date, time, mergeKey required");
  }

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
  if (total < DEFAULT_MAX_AMOUNT) throw new Error("Not enough amount to confirm");

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

  await addTimelineEvent({
    orderId: `${companyCode}_${date}_${time}_${mergeKey}`,
    event: "MERGE_CONFIRMED_BY_MANAGER",
    by: managerId || "MANAGER",
    extra: { mergeKey, totalAmount: total, time },
  });

  return { ok: true, mergeKey, totalAmount: total, status: "CONFIRMED" };
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
  if (!companyCode || !date || !time || !bookingSk || !fromMergeKey || !toMergeKey) {
    throw new Error("Missing required fields");
  }

  const pk = pkFor(companyCode, date);
  const fromSk = skForMergeSlot(time, fromMergeKey);
  const toSk = skForMergeSlot(time, toMergeKey);

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

  await addTimelineEvent({
    orderId: booking.orderId || booking.bookingId,
    event: "BOOKING_MOVED_BY_MANAGER",
    by: managerId || "MANAGER",
    extra: { fromMergeKey, toMergeKey, amount: amt, time },
  });

  return { ok: true, fromMergeKey, toMergeKey, movedAmount: amt };
}

/* ---------------- WAITING QUEUE ---------------- */

export async function joinWaiting({
  companyCode,
  date,
  time,
  userId,
  distributorCode,
}) {
  const uid = (userId && String(userId).trim()) ? String(userId).trim() : uuidv4();

  const pk = `COMPANY#${companyCode}#DATE#${date}#SLOT#${time}`;
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
        status: "WAITING",
        createdAt: new Date().toISOString(),
      },
    })
  );

  return { ok: true, message: "Added to waiting queue" };
}

/* ---------------- CANCEL SLOT ---------------- */

export async function cancelSlot({ companyCode, date, time, pos, userId }) {
  const uid = (userId && String(userId).trim()) ? String(userId).trim() : null;
  if (!uid) throw new Error("userId required for cancel");

  const pk = pkFor(companyCode, date);
  const slotSk = skForSlot(time, "FULL", pos);
  const bookingSk = skForBooking(time, "FULL", pos, uid);

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
