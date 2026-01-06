import { ddb } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

// ✅ GET DRIVER USERS
export async function getDrivers(req, res) {
  try {
    const out = await ddb.send(
      new QueryCommand({
        TableName: "tickin_users",
        IndexName: "role-index",   // ✅ your GSI
        KeyConditionExpression: "#r = :r",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: {
          ":r": "DRIVER",
        },
      })
    );

    const drivers = (out.Items || []).map((d) => ({
      name: d.name || d.userName || d.mobile,
      mobile: d.mobile,
    }));

    return res.json({
      ok: true,
      drivers,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || String(e),
    });
  }
}
export const assignCompany = async (req, res) => {
  try {
    return res.json({ ok: true, message: "assignCompany not implemented yet" });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
