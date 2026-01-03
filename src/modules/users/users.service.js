import { ddb } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

// ✅ GET DRIVER USERS
export const getDrivers = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "contains(#r, :driver)",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":driver": "DRIVER" },
      })
    );

    const drivers = (result.Items || []).map((d) => ({
      pk: d.pk,
      name: d.name,
      mobile: d.mobile,
      role: d.role,
    }));

    return res.json({ ok: true, count: drivers.length, drivers });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
export const assignCompany = async (req, res) => {
  try {
    return res.json({ ok: true, message: "assignCompany not implemented yet" });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
