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
function skForLocationSlot(time, location) {
  return `LOC_SLOT#${time}#LOC#${location}`;
}
function skForBooking(time, vehicleType, pos, userId) {
  return `BOOKING#${time}#TYPE#${vehicleType}#POS#${pos}#USER#${userId}`;
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
      const id = String(d?.distributorId || "").trim();       // sometimes
      const dc = String(d?.distributorCode || "").trim();     // excel usually
      const sk = String(d?.code || "").trim();                // optional alias
      return id === code || dc === code || sk === code;
    });

    if (found) {
      return { location, distributor: found };
    }
  }

  return { location: null, distributor: null };
}
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

// ✅ Update rule table (used for last slot enable)
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

  return finalSlots;
}

/**
 * ✅ Manager Open Last Slot
 * ✅ AFTER 5PM ONLY
 * ✅ updates tickin_slot_rules so bookSlot passes validation
 * ✅ 4×4 default (A,B,C,D)
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

  // ✅ enable last slot in RULES table
  await setRule(companyCode, {
    lastSlotEnabled: true,
    lastSlotOpenAfter: openAfter,
  });

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
 * ✅ Manager Set Slot Max Amount
 */
export async function managerSetSlotMaxAmount({
  companyCode,
  date,
  time,
  location,
  maxAmount,
}) {
  const pk = pkFor(companyCode, date);
  const sk = skForLocationSlot(time, location);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk },
      UpdateExpression: "SET maxAmount = :m, #t = :t, #loc = :loc",
      ExpressionAttributeNames: { "#t": "time", "#loc": "location" },
      ExpressionAttributeValues: {
        ":m": Number(maxAmount),
        ":t": time,
        ":loc": Number(location),
      },
    })
  );

  return { ok: true, message: "MaxAmount updated ✅", maxAmount: Number(maxAmount) };
}

/**
 * ✅ BOOK SLOT
 * ✅ Security: non-manager can book only own distributorCode (service-level)
 * ✅ Amount decides FULL/HALF (service-level)
 */
export async function bookSlot({
  companyCode,
  date,
  time,
  vehicleType = "FULL",
  pos,
  userId,
  distributorCode,
  amount = 0,
  orderId,

  // ✅ NEW fields from route
  requesterRole = "UNKNOWN",
  requesterDistributorCode = null,
}) {
  const pk = pkFor(companyCode, date);

  // ✅ SECURITY (cannot bypass routes)
  const isMgr = requesterRole === "MANAGER" || requesterRole === "MASTER";
  if (!isMgr) {
    if (!requesterDistributorCode) {
      throw new Error("User distributorCode missing in token");
    }
    if (
      String(requesterDistributorCode).trim() !== String(distributorCode).trim()
    ) {
      throw new Error("You can book slot only for your own distributorCode");
    }
  }

  // ✅ Amount based HARD RULE (>=80k FULL else HALF)
  const amt = Number(amount || 0);
  const computedType = amt >= DEFAULT_MAX_AMOUNT ? "FULL" : "HALF";
  vehicleType = computedType;

  // ✅ last slot rule check
  if (time === "20:30") {
    const rule = await getRule(companyCode);

    if (rule && rule.lastSlotEnabled === false) {
      throw new Error("Last slot not enabled by manager");
    }

    const openAfter = rule?.lastSlotOpenAfter || "17:00";
    const nowTime = dayjs().format("HH:mm");

    if (nowTime < openAfter) {
      throw new Error(`Last slot opens only after ${openAfter}`);
    }
  }

  // ✅ FULL booking (4×4)
  if (vehicleType === "FULL") {
    const slotSk = skForSlot(time, vehicleType, pos);
    const bookingSk = skForBooking(time, vehicleType, pos, userId);
    const bookingId = uuidv4();

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_CAPACITY,
              Key: { pk, sk: slotSk },
              ConditionExpression: "attribute_not_exists(#s) OR #s = :available",
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
                ":vt": vehicleType,
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
                vehicleType,
                pos,
                userId,
                distributorCode: distributorCode || null,
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
        extra: {
          vehicleType: "FULL",
          time,
          pos,
          distributorCode,
          bookingId,
        },
      });
    }

    return { ok: true, bookingId, type: "FULL" };
  }

  // ✅ HALF Booking Logic (location merge)
  let { location, distributor } = findDistributorFromPairingMap(
    pairingMap,
    distributorCode
  );

  if (!location) {
    const distRes = await ddb.send(
      new GetCommand({
        TableName: "tickin_distributors",
        Key: { pk: "DISTRIBUTOR", sk: String(distributorCode) },
      })
    );

    location = distRes.Item?.location;
    distributor = distRes.Item || null;
  }

  if (!location) {
    throw new Error(`Distributor location not found for ${distributorCode}`);
  }

  const locSk = skForLocationSlot(time, location);
  const bookingId = uuidv4();
  const bookingSk = `BOOKING#${time}#LOC#${location}#USER#${userId}#${bookingId}`;

  const current = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: locSk },
    })
  );

  const existing = current.Item || null;
  const currentTotal = Number(existing?.totalAmount || 0);
  const maxAmount = Number(existing?.maxAmount || DEFAULT_MAX_AMOUNT);

  if (existing?.tripStatus === "FULL") {
    throw new Error("Trip already full for this location slot");
  }

  const newTotal = currentTotal + amt;
  const newTripStatus = newTotal >= maxAmount ? "FULL" : "PARTIAL";

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_CAPACITY,
            Key: { pk, sk: locSk },
            ConditionExpression:
              "attribute_not_exists(tripStatus) OR tripStatus <> :full",
            UpdateExpression:
              "SET #t = :t, #loc = :loc, maxAmount = if_not_exists(maxAmount, :m), totalAmount = :newTotal, tripStatus = :ts",
            ExpressionAttributeNames: { "#t": "time", "#loc": "location" },
            ExpressionAttributeValues: {
              ":t": time,
              ":loc": Number(location),
              ":m": maxAmount,
              ":newTotal": newTotal,
              ":ts": newTripStatus,
              ":full": "FULL",
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
              pos,
              userId,
              distributorCode,
              location: Number(location),
              amount: amt,
              tripStatus: newTripStatus,
              status: "CONFIRMED",
              createdAt: new Date().toISOString(),

              distributorName:
                distributor?.distributorName || distributor?.name || null,
              area: distributor?.area || null,
              phoneNumber: distributor?.phoneNumber || distributor?.phone || null,
            },
          },
        },
      ],
    })
  );

  if (orderId) {
    await addTimelineEvent({
      orderId,
      event: newTripStatus === "FULL" ? "HALF_MERGED_FULL" : "HALF_BOOKED",
      by: userId,
      extra: {
        vehicleType: "HALF",
        time,
        location,
        amount: amt,
        totalAmount: newTotal,
        maxAmount,
        tripStatus: newTripStatus,
        bookingId,
        distributorCode,
      },
    });
  }

  return {
    ok: true,
    bookingId,
    type: "HALF",
    location,
    totalAmount: newTotal,
    maxAmount,
    tripStatus: newTripStatus,
  };
}

/**
 * ✅ CANCEL SLOT
 * ✅ only manager route allows; service keeps same behaviour
 */
export async function cancelSlot({
  companyCode,
  date,
  time,
  vehicleType = "FULL",
  pos,
  userId,
  orderId,
}) {
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
              ConditionExpression: "userId = :uid AND #s = :booked",
              UpdateExpression: "SET #s = :available REMOVE userId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":uid": userId,
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

  throw new Error("HALF cancel not supported yet (manager can clear manually)");
}

/**
 * ✅ WAITING QUEUE JOIN
 */
export async function joinWaiting({
  companyCode,
  date,
  time,
  vehicleType = "HALF",
  userId,
  distributorCode,
  orderId,
}) {
  const pk = `COMPANY#${companyCode}#DATE#${date}#SLOT#${time}#TYPE#${vehicleType}`;
  const sk = `WAIT#${new Date().toISOString()}#USER#${userId}`;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_QUEUE,
      Item: {
        pk,
        sk,
        slotTime: time,
        vehicleType,
        userId,
        distributorCode: distributorCode || null,
        status: "WAITING",
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    })
  );

  if (orderId) {
    await addTimelineEvent({
      orderId,
      event: "SLOT_WAITING",
      by: userId,
      extra: { vehicleType, time, distributorCode },
    });
  }

  return { ok: true, message: "Added to waiting queue" };
}
