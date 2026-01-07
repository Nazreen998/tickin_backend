import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const TABLE = "VAGR_Attendance";

export const Attendance = {

  async findToday(uid, date) {
    return ddb.send(new GetCommand({
      TableName: TABLE,
      Key: {
        PK: `USER#${uid}`,
        SK: `DATE#${date}`
      }
    }));
  },

  async checkIn({ uid, date, lat, lng, distance }) {
    return ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${uid}`,
        SK: `DATE#${date}`,
        checkInAt: new Date().toISOString(),
        lat,
        lng,
        distance,
        status: "CHECKED_IN",
        createdAt: new Date().toISOString()
      },
      ConditionExpression: "attribute_not_exists(PK)"
    }));
  },

  async checkOut({ uid, date }) {
    return ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `USER#${uid}`,
        SK: `DATE#${date}`
      },
      UpdateExpression: "SET checkOutAt = :t, #s = :s",
      ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(checkOutAt)",
      ExpressionAttributeNames: {
        "#s": "status"
      },
      ExpressionAttributeValues: {
        ":t": new Date().toISOString(),
        ":s": "CHECKED_OUT"
      }
    }));
  }
};
