import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const TABLE = "VAGR_Attendance";

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

  async checkIn({ uid, date, lat, lng, distance, locationId, locationName }) {
    return ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `USER#${uid}`,
          SK: `DATE#${date}`,
          checkInAt: new Date().toISOString(),
          lat,
          lng,
          distance,
          locationId,
          locationName,
          status: "CHECKED_IN",
          createdAt: new Date().toISOString()
        },
        ConditionExpression: "attribute_not_exists(PK)"
      })
    );
  },

  async checkOut({ uid, date, lat, lng }) {
    return ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: {
          PK: `USER#${uid}`,
          SK: `DATE#${date}`
        },
        UpdateExpression:
          "SET checkOutAt = :t, checkOutLat = :lat, checkOutLng = :lng, #s = :s",
        ConditionExpression:
          "attribute_exists(PK) AND attribute_not_exists(checkOutAt)",
        ExpressionAttributeNames: {
          "#s": "status"
        },
        ExpressionAttributeValues: {
          ":t": new Date().toISOString(),
          ":lat": lat,
          ":lng": lng,
          ":s": "CHECKED_OUT"
        }
      })
    );
  }
};
