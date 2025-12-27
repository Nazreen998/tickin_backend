import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import { ddb } from "../../config/dynamo.js";

import {
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_CAPACITY = "tickin_slot_capacity";
const TABLE_BOOKINGS = "tickin_slot_bookings";
const TABLE_QUEUE = "tickin_slot_waiting_queue";
const TABLE_RULES = "tickin_slot_rules";

// ✅ SYSTEM DEFAULT SLOTS (DO NOT STORE IN DB)
const DEFAULT_SLOTS = ["09:00", "12:30", "16:30", "20:30"];
const ALL_POSITIONS = ["A", "B", "C", "D"];

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

/**
 * ✅ GET SLOT GRID (ALWAYS RETURN DEFAULT GRID)
 * DB stores only overrides
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
 * Manager cannot modify BOOKED + FULL slots
 */
export async function managerOpenLastSlot({
  companyCode,
  date,
  vehicleType = "FULL",
  time = "20:30",
  allowedPositions = ["A", "B"],
}) {
  const pk = pkFor(companyCode, date);

  const rule = await getRule(companyCode);
  const openAfter = rule?.lastSlotOpenAfter || "17:00";
  const nowTime = dayjs().format("HH:mm");

  // Optional strict rule
  // if (nowTime < openAfter) throw new Error(`Last slot open only after ${openAfter}`);

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
  return { ok: true, message: "Last slot updated", allowedPositions };
}

/**
 * ✅ BOOK SLOT (UPSERT - works even if slot row missing)
 */
export async function bookSlot({
  companyCode,
  date,
  time,
  vehicleType = "FULL",
  pos,
  userId,
  distributorCode,
}) {
  const pk = pkFor(companyCode, date);
  const slotSk = skForSlot(time, vehicleType, pos);
  const bookingSk = skForBooking(time, vehicleType, pos, userId);

  // last slot rule check
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

  return { ok: true, bookingId };
}

/**
 * ✅ CANCEL SLOT
 */
export async function cancelSlot({
  companyCode,
  date,
  time,
  vehicleType = "FULL",
  pos,
  userId,
}) {
  const pk = pkFor(companyCode, date);
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

  return { ok: true };
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

  return { ok: true, message: "Added to waiting queue" };
}
