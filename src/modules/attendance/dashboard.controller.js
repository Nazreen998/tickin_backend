import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

const TABLE = "VAGR_Attendance";

/** IST HELPERS */

/**
 * 👉 DATE KEY FORMAT (FOR DYNAMODB)
 * Always YYYY-MM-DD
 * Matches: GSI1PK = DATE#2026-01-09
 */
const todayIST = () => {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};

/**
 * 👉 DISPLAY / LOG PURPOSE ONLY
 * NOT USED FOR DB QUERIES
 */
const getISTNow = () =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  
  /**
  Helper – get all dates in month (IST)
 **/
  const getMonthDates = (year, month) => {
  const dates = [];
  const d = new Date(year, month - 1, 1);

  while (d.getMonth() === month - 1) {
    dates.push(
      d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    );
    d.setDate(d.getDate() + 1);
  }
  return dates;
};

const isSunday = (dateStr) => {
  const d = new Date(dateStr);
  return d.getDay() === 0; // Sunday
};


/**
 * GET /attendance/dashboard/today
 */
export const todayAttendance = async (req, res) => {
  const date = todayIST();

  const params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: {
      ":pk": `DATE#${date}`,
    },

    // ❗ FIX: reserved keywords handled
    ProjectionExpression:
      "PK, userName, #r, attendanceRole, locationId, bataAmount, nightAllowance, checkInAt, checkOutAt, #s",
    ExpressionAttributeNames: {
      "#r": "role",
      "#s": "status",
    },
  };

  const data = await ddb.send(new QueryCommand(params));
  res.json({ ok: true, data: data.Items || [] });
};

/**
 * GET /attendance/dashboard/by-date
 * ?date=YYYY-MM-DD
 */
export const attendanceByDate = async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.json({ ok: false, error: "date_required" });
  }

  const params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: {
      ":pk": `DATE#${date}`,
    },

    // ❗ FIX: reserved keywords handled
    ProjectionExpression:
      "PK, userName, #r, attendanceRole, locationId, bataAmount, nightAllowance, checkInAt, checkOutAt, #s",
    ExpressionAttributeNames: {
      "#r": "role",
      "#s": "status",
    },
  };

  const data = await ddb.send(new QueryCommand(params));
  res.json({ ok: true, data: data.Items || [] });
};

/**
 * GET /attendance/dashboard/weekly-summary
 */
export const weeklySummary = async (req, res) => {
  const dates = [];

  for (let i = 0; i < 6; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(
      d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    );
  }

  const users = {};

  for (const date of dates) {
    const params = {
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `DATE#${date}`,
      },

      // ❗ FIX: role handled safely
      ProjectionExpression:
        "PK, userName, #r, attendanceRole, bataAmount, nightAllowance, locationId",
      ExpressionAttributeNames: {
        "#r": "role",
      },
    };

    const data = await ddb.send(new QueryCommand(params));

    for (const item of data.Items || []) {
      const uid = item.PK.replace("USER#", "");

      if (!users[uid]) {
        users[uid] = {
          uid,
          name: item.userName,
          role: item.attendanceRole || item.role,
          presentDays: 0,
          totalBata: 0,
          nightAllowance: 0,
          office2Visits: 0,
        };
      }

      users[uid].presentDays++;
      users[uid].totalBata += item.bataAmount || 0;
      users[uid].nightAllowance += item.nightAllowance || 0;

      // 👇 OFFICE2 visit tracking
      if (item.locationId === "OFFICE2") {
        users[uid].office2Visits++;
      }
    }
  }

  const result = Object.values(users).map((u) => ({
    ...u,
    absentDays: 6 - u.presentDays,
    totalAmount: u.totalBata + u.nightAllowance,
    visitedOffice2: u.office2Visits > 0 ? "YES" : "NO",
  }));

  res.json({ ok: true, data: result });
};

/**
 * GET /attendance/dashboard/monthly-summary
 */
export const monthlySummary = async (req, res) => {
  const { month } = req.query; // YYYY-MM

  if (!month) {
    return res.json({ ok: false, error: "month_required" });
  }

  const [year, m] = month.split("-").map(Number);
  const dates = getMonthDates(year, m);

  const users = {};
  let workingDays = 0;

  for (const date of dates) {
    if (isSunday(date)) continue; // 🚫 Skip Sunday
    workingDays++;

    const params = {
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `DATE#${date}`,
      },
      ProjectionExpression:
        "PK, userName, #r, attendanceRole",
      ExpressionAttributeNames: {
        "#r": "role",
      },
    };

    const data = await ddb.send(new QueryCommand(params));

    for (const item of data.Items || []) {
      const uid = item.PK;

      if (!users[uid]) {
        users[uid] = {
          name: item.userName,
          role: item.attendanceRole || item.role,
          presentDays: 0,
        };
      }

      users[uid].presentDays++;
    }
  }

  const result = Object.values(users).map((u) => ({
    ...u,
    totalDays: workingDays,
    absentDays: workingDays - u.presentDays,
  }));

  res.json({ ok: true, data: result });
};
