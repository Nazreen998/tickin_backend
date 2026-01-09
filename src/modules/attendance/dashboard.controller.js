import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

const TABLE = "VAGR_Attendance";

/** IST HELPERS */
const todayIST = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const getISTNow = () =>
  new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

/**
 * GET /attendance/dashboard/today
 * ?officeId=PERUNGUDI
 */
export const todayAttendance = async (req, res) => {
  const { officeId } = req.query;
  const date = todayIST();

  let params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: {
      ":pk": `DATE#${date}`
    }
  };

  if (officeId) {
    params.KeyConditionExpression +=
      " AND begins_with(GSI1SK, :sk)";
    params.ExpressionAttributeValues[":sk"] =
      `LOC#${officeId}`;
  }

  const data = await ddb.send(new QueryCommand(params));
  res.json({ ok: true, data: data.Items || [] });
};

/**
 * GET /attendance/dashboard/by-date
 * ?date=YYYY-MM-DD&officeId=PERUNGUDI
 */
export const attendanceByDate = async (req, res) => {
  const { date, officeId } = req.query;

  if (!date) {
    return res.json({ ok: false, error: "date_required" });
  }

  let params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: {
      ":pk": `DATE#${date}`
    }
  };

  if (officeId) {
    params.KeyConditionExpression +=
      " AND begins_with(GSI1SK, :sk)";
    params.ExpressionAttributeValues[":sk"] =
      `LOC#${officeId}`;
  }

  const data = await ddb.send(new QueryCommand(params));
  res.json({ ok: true, data: data.Items || [] });
};

/**
 * GET /attendance/dashboard/weekly-summary
 * ?officeId=PERUNGUDI
 */
export const weeklySummary = async (req, res) => {
  const { officeId } = req.query;

  const now = getISTNow();
  const day = now.getDay() || 7; // Sunday = 7

  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);

  // Working days: Mon–Sat (6 days)
  const dates = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toLocaleDateString("en-CA"));
  }

  const users = {};

  for (const date of dates) {
    let params = {
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `DATE#${date}`
      }
    };

    if (officeId) {
      params.KeyConditionExpression +=
        " AND begins_with(GSI1SK, :sk)";
      params.ExpressionAttributeValues[":sk"] =
        `LOC#${officeId}`;
    }

    const data = await ddb.send(new QueryCommand(params));

    for (const item of data.Items || []) {
      const uid = item.PK.replace("USER#", "");

      if (!users[uid]) {
        users[uid] = {
          uid,
          name: item.userName,
          role: item.role || "-",
          presentDays: 0,
          totalBata: 0,
          nightAllowance: 0
        };
      }

      users[uid].presentDays += 1;
      users[uid].totalBata += item.bataAmount || 0;
      users[uid].nightAllowance += item.nightAllowance || 0;
    }
  }

  const result = Object.values(users).map(u => ({
    ...u,
    absentDays: 6 - u.presentDays,
    totalAmount: u.totalBata + u.nightAllowance
  }));

  res.json({ ok: true, data: result });
};
