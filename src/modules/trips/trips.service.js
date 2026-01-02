import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

const TABLE_TRIPS = "tickin_trips";

// ✅ List trips (manager/master)
export const getTripsList = async (req, res) => {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_TRIPS,
        IndexName: "GSI1", // OPTIONAL if you create GSI
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: {
          ":pk": "TRIPS",
        },
      })
    );

    return res.json({ ok: true, count: result.Items.length, trips: result.Items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// ✅ Trip Details
export const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;

    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_TRIPS,
        Key: { pk: `TRIP#${tripId}`, sk: "META" },
      })
    );

    if (!result.Item) return res.status(404).json({ ok: false, message: "Trip not found" });

    return res.json({ ok: true, trip: result.Item });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// ✅ Manager update trip status + assign driver + vehicle
export const updateTripStatus = async (req, res) => {
  try {
    const { tripId } = req.params;
    const { status, driverId, vehicleNo } = req.body;

    const updates = [];
    const values = {};
    const names = {};

    if (status) {
      updates.push("#s = :s");
      values[":s"] = status;
      names["#s"] = "status";
    }
    if (driverId) {
      updates.push("driverId = :d");
      values[":d"] = driverId;
    }
    if (vehicleNo) {
      updates.push("vehicleNo = :v");
      values[":v"] = vehicleNo;
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, message: "Nothing to update" });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_TRIPS,
        Key: { pk: `TRIP#${tripId}`, sk: "META" },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: names,
      })
    );

    return res.json({ ok: true, message: "Trip updated ✅" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
