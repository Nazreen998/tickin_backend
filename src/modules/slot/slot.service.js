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

/**
 * ✅ Find location + distributor details from pairingMap (Excel)
 */
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

/** ---------------- TRIP HELPERS ---------------- **/

function tripPk(companyCode, date) {
  return `COMPANY#${companyCode}#DATE#${date}`;
}

function tripSkFULL(time, pos) {
  return `TRIP#${time}#TYPE#FULL#POS#${pos}`;
}

function tripSkHALF(time, mergeKey) {
  return `TRIP#${time}#TYPE#HALF#KEY#${mergeKey}`;
}

async function ensureTrip({
  companyCode,
  date,
  time,
  vehicleType,
  pos = null,
  mergeKey = null,
  mergeType = null,
  location = null,
  maxAmount = DEFAULT_MAX_AMOUNT,
}) {
  const pk = tripPk(companyCode, date);

  const sk =
    vehicleType === "FULL"
      ? tripSkFULL(time, pos)
      : tripSkHALF(time, mergeKey);

  const existing = await ddb.send(
    new GetCommand({
      TableName: TABLE_TRIPS,
      Key: { pk, sk },
    })
  );

  if (existing.Item) return existing.Item;

  const item = {
    pk,
    sk,
    companyCode,
    date,
    time,
    vehicleType,
    pos: vehicleType === "FULL" ? pos : null,
    mergeKey: vehicleType === "HALF" ? mergeKey : null,
    mergeType: vehicleType === "HALF" ? mergeType : null,
    location: vehicleType === "HALF" ? String(location || "") : null,

    // ✅ DEFAULT STATUS
    tripStatus: vehicleType === "FULL" ? "FULL_CONFIRMED" : "PARTIAL",
    totalAmount: 0,
    maxAmount: Number(maxAmount || DEFAULT_MAX_AMOUNT),

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_TRIPS,
      Item: item,
    })
  );

  return item;
}

async function updateTripTotals({
  companyCode,
  date,
  time,
  vehicleType,
  pos = null,
  mergeKey = null,
  totalAmount,
  tripStatus,
  maxAmount,
}) {
  const pk = tripPk(companyCode, date);

  const sk =
    vehicleType === "FULL"
      ? tripSkFULL(time, pos)
      : tripSkHALF(time, mergeKey);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_TRIPS,
      Key: { pk, sk },
      UpdateExpression:
        "SET totalAmount = :t, tripStatus = :s, maxAmount = :m, updatedAt = :u",
      ExpressionAttributeValues: {
        ":t": Number(totalAmount || 0),
        ":s": String(tripStatus),
        ":m": Number(maxAmount || DEFAULT_MAX_AMOUNT),
        ":u": new Date().toISOString(),
      },
    })
  );

  return { ok: true, pk, sk, totalAmount, tripStatus };
}

/** ---------------- RULES HELPERS ---------------- **/

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

/**
 * ✅ GET SLOT GRID
 */
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

/**
 * ✅ Manager Open Last Slot
 */
export async function managerOpenLastSlot({
  companyCode,
  date,
  vehicleType = "FULL",
  time = "20:30",
  allowedPositions = ["A", "B", "C", "D"],
  openAfter = "17:00",
}) {
  const nowTime = dayjs().format("HH:mm");
  if (nowTime < openAfter) {
    throw new Error(`Last slot can be opened only after ${openAfter}`);
  }

  await setRule(companyCode, { lastSlotEnabled: true, lastSlotOpenAfter: openAfter });

  const pk = pkFor(companyCode, date);

  const updates = [];
  for (const pos of ALL_POSITIONS) {
    const sk = skForSlot(time, vehicleType, pos);
    const newStatus = allowedPositions.includes(pos) ? "AVAILABLE" : "CLOSED";

    updates.push(
      ddb.send(
        new UpdateCommand({
          TableName: TABLE_CAPACITY,
          Key: { pk, sk },
          ConditionExpression: "NOT (#s = :booked AND #vt = :full)",
          UpdateExpression: "SET #s = :s, #t = :t, #vt = :vt, #p = :p",
          ExpressionAttributeNames: {
            "#s": "status",
            "#t": "time",
            "#vt": "vehicleType",
            "#p": "pos",
          },
          ExpressionAttributeValues: {
            ":s": newStatus,
            ":booked": "BOOKED",
            ":full": "FULL",
            ":t": time,
            ":vt": vehicleType,
            ":p": pos,
          },
        })
      )
    );
  }

  await Promise.all(updates);

  return { ok: true, message: "Last slot updated ✅", allowedPositions, openAfter };
}

/**
 * ✅ BOOK SLOT (FINAL UPDATED)
 */
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

  /** ---------------- FULL booking ---------------- */
  if (vehicleType === "FULL") {
    if (!pos) throw new Error("pos required for FULL booking");

    const slotSk = skForSlot(time, "FULL", pos);
    const bookingSk = skForBooking(time, "FULL", pos, userId);
    const bookingId = uuidv4();

    await ensureTrip({
      companyCode,
      date,
      time,
      vehicleType: "FULL",
      pos,
      maxAmount: DEFAULT_MAX_AMOUNT,
    });

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: slotSk },
              ConditionExpression:
                "attribute_not_exists(#s) OR #s = :available",
              UpdateExpression:
                "SET #s = :booked, userId = :uid, #t = :t, #vt = :vt, #p = :p",
              ExpressionAttributeNames: {
                "#s": "status",
                "#t": "time",
                "#vt": "vehicleType",
                "#p": "pos",
              },
              ExpressionAttributeValues: {
                ":available": "AVAILABLE",
                ":booked": "BOOKED",
                ":uid": userId,
                ":t": time,
                ":vt": "FULL",
                ":p": pos,
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
                userId,
                distributorCode,
                amount: amt,
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
        by: userId,
        extra: { vehicleType: "FULL", time, pos, distributorCode, bookingId },
      });
    }

    return { ok: true, bookingId, type: "FULL" };
  }

  /** ---------------- HALF booking ---------------- */
  let { location, distributor } = findDistributorFromPairingMap(pairingMap, distributorCode);

  if (!location) throw new Error(`Distributor location not found for ${distributorCode}`);

  const mergeKey = `LOC#${location}`;
  const mergeSk = skForMergeSlot(time, mergeKey);

  // ✅ check if bucket already exists
  const current = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const existing = current.Item || null;

  // ✅ if already exists, push to waiting
  if (existing && ["PARTIAL", "FULL_PENDING", "FULL_CONFIRMED"].includes(existing.tripStatus)) {
    const waitPk = `WAIT#${companyCode}#${date}#${time}#${mergeKey}`;
    const waitSk = `USER#${userId}#${uuidv4()}`;

    await ddb.send(
      new PutCommand({
        TableName: TABLE_QUEUE,
        Item: {
          pk: waitPk,
          sk: waitSk,
          companyCode,
          date,
          time,
          mergeKey,
          distributorCode,
          userId,
          amount: amt,
          status: "WAITING",
          createdAt: new Date().toISOString(),
        },
      })
    );

    if (orderId) {
      await addTimelineEvent({
        orderId,
        event: "SLOT_WAITING",
        by: userId,
        extra: { vehicleType: "HALF", time, distributorCode, mergeKey },
      });
    }

    return {
      ok: true,
      status: "WAITING",
      message: "Half slot in progress. Added to waiting queue ✅",
    };
  }

  // ✅ new bucket create
  const bookingId = uuidv4();
  const bookingSk = `BOOKING#${time}#KEY#${mergeKey}#USER#${userId}#${bookingId}`;

  const newTotal = amt;
  const tripStatus = newTotal >= DEFAULT_MAX_AMOUNT ? "FULL_PENDING" : "PARTIAL";

  await ensureTrip({
    companyCode,
    date,
    time,
    vehicleType: "HALF",
    mergeKey,
    mergeType: "LOCATION",
    location,
    maxAmount: DEFAULT_MAX_AMOUNT,
  });

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_CAPACITY,
            Item: {
              pk,
              sk: mergeSk,
              time,
              mergeKey,
              mergeType: "LOCATION",
              location: String(location),
              totalAmount: newTotal,
              maxAmount: DEFAULT_MAX_AMOUNT,
              tripStatus,
              status: "MERGE",
              createdAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
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
              mergeType: "LOCATION",
              amount: amt,

              // ✅ status based on pending
              status: tripStatus,
              createdAt: new Date().toISOString(),

              // ✅ LAT/LNG from pairingMap
              lat: distributor?.lat || null,
              lng: distributor?.lng || null,
              final_url: distributor?.final_url || null,
            },
          },
        },
      ],
    })
  );

  await updateTripTotals({
    companyCode,
    date,
    time,
    vehicleType: "HALF",
    mergeKey,
    totalAmount: newTotal,
    tripStatus,
    maxAmount: DEFAULT_MAX_AMOUNT,
  });

  if (orderId) {
    await addTimelineEvent({
      orderId,
      event: "SLOT_BOOKED",
      by: userId,
      extra: { vehicleType: "HALF", time, mergeKey, location, amount: amt, tripStatus },
    });
  }

  return {
    ok: true,
    bookingId,
    type: "HALF",
    tripStatus,
    totalAmount: newTotal,
    maxAmount: DEFAULT_MAX_AMOUNT,
    mergeKey,
    location,
    distributor,
  };
}

/**
 * ✅ MANAGER CONFIRM HALF TRIP
 * FULL_PENDING → FULL_CONFIRMED
 */
export async function managerConfirmHalfTrip({ companyCode, date, time, mergeKey }) {
  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeSlot(time, mergeKey);

  const current = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  if (!current.Item) throw new Error("Merge slot not found");
  if (current.Item.tripStatus !== "FULL_PENDING") throw new Error("Only FULL_PENDING can be confirmed");

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression: "SET tripStatus = :s, confirmedAt = :t",
      ExpressionAttributeValues: {
        ":s": "FULL_CONFIRMED",
        ":t": new Date().toISOString(),
      },
    })
  );

  await updateTripTotals({
    companyCode,
    date,
    time,
    vehicleType: "HALF",
    mergeKey,
    totalAmount: current.Item.totalAmount,
    tripStatus: "FULL_CONFIRMED",
    maxAmount: current.Item.maxAmount,
  });

  return { ok: true, message: "✅ HALF trip confirmed by manager", mergeKey, time };
}

/**
 * ✅ CANCEL SLOT (FULL மட்டும்)
 */
export async function cancelSlot({ companyCode, date, time, vehicleType = "FULL", pos, userId, orderId }) {
  const pk = pkFor(companyCode, date);

  if (vehicleType === "FULL") {
    const slotSk = skForSlot(time, vehicleType, pos);
    const bookingSk = skForBooking(time, vehicleType, pos, userId);

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: slotSk },
              ConditionExpression: "#s = :booked",
              UpdateExpression: "SET #s = :available REMOVE userId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":booked": "BOOKED",
                ":available": "AVAILABLE",
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

    if (orderId) {
      await addTimelineEvent({
        orderId,
        event: "SLOT_CANCELLED",
        by: userId,
        extra: { vehicleType, time, pos },
      });
    }

    return { ok: true };
  }

  throw new Error("HALF cancel not supported (manager only)");
}
