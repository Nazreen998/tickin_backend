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

// ✅ GET SLOT GRID
export async function getSlotGrid({ companyCode, date }) {
  const pk = pkFor(companyCode, date);

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CAPACITY,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const items = (res.Items || []).sort((a, b) => (a.sk > b.sk ? 1 : -1));
  return items;
}

// ✅ Manager Open Last Slot
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

  // Optional strict check
  // if (nowTime < openAfter) throw new Error(`Last slot open only after ${openAfter}`);

  const allPos = ["A", "B", "C", "D"];
  const updates = [];

  for (const pos of allPos) {
    const sk = skForSlot(time, vehicleType, pos);
    const newStatus = allowedPositions.includes(pos) ? "AVAILABLE" : "CLOSED";

    updates.push(
      ddb.send(
        new UpdateCommand({
          TableName: TABLE_CAPACITY,
          Key: { pk, sk },
          UpdateExpression: "SET #status = :s",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": newStatus },
        })
      )
    );
  }

  await Promise.all(updates);
  return { ok: true, message: "Last slot updated", allowedPositions };
}

// ✅ BOOK SLOT
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
            ConditionExpression: "#status = :available",
            UpdateExpression: "SET #status = :booked, userId = :uid",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":available": "AVAILABLE",
              ":booked": "BOOKED",
              ":uid": userId,
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

// ✅ CANCEL SLOT
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
            ConditionExpression: "userId = :uid AND #status = :booked",
            UpdateExpression: "SET #status = :available REMOVE userId",
            ExpressionAttributeNames: { "#status": "status" },
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

// ✅ WAITING QUEUE
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
