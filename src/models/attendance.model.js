import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const TABLE = "VAGR_Attendance";
 
/*** TIME HELPERS ***/
const nowIST = () =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

export const Attendance = {

  async get(uid, date) {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: `USER#${uid}`,
          SK: `DATE#${date}`
        }
      })
    );
    return res.Item || null;
  },

  async checkIn({ uid,userName,role,attendanceRole,date, lat, lng, distance, locationId, locationName,bataAmount,bataReason }) {
    return ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `USER#${uid}`,
          SK: `DATE#${date}`,
          // 🔹 GSI for dashboard queries
          GSI1PK: `DATE#${date}`,
          GSI1SK: `LOC#${locationId}#USER#${uid}`,
          userName,
          role,
          attendanceRole,
          checkInAt: nowIST(),          
          lat,
          lng,
          distance,
          locationId,
          locationName,
          // 🔹 Allowance fields (safe defaults)
          bataAmount,
          bataReason,
          nightAllowance: 0,
          status: "CHECKED_IN",
          createdAt: nowIST()
        },
        ConditionExpression: "attribute_not_exists(SK)"
      })
    );
  },

  async checkOut({ uid, date, lat, lng,nightAllowance}) {
    return ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: {
          PK: `USER#${uid}`,
          SK: `DATE#${date}`
        },
        UpdateExpression:
          "SET checkOutAt = :t, checkOutLat = :lat, checkOutLng = :lng, #s = :s, nightAllowance = :n",
        ConditionExpression:
          "attribute_exists(PK) AND attribute_not_exists(checkOutAt)",
        ExpressionAttributeNames: {
          "#s": "status"
        },
        ExpressionAttributeValues: {
          ":t": nowIST(),
          ":lat": lat,
          ":lng": lng,
          ":n": nightAllowance,
          ":s": "CHECKED_OUT"
        }
      })
    );
  }
};
