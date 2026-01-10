import { ddb } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

/**
 * ✅ GET DRIVERS (Role = DRIVER)
 * URL: GET /api/users/drivers
 */
export const getDrivers = async (req, res) => {
  try {
    const out = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "#r = :r",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":r": "DRIVER" },
      })
    );

    // ✅ Clean response for dropdown usage
    const drivers = (out.Items || []).map((d) => ({
      name: d.name || d.userName || d.mobile || "Unknown",
      mobile: d.mobile || "",
      id: d.pk || d.id || d.userId || d.mobile || "",
    }));

    return res.json({
      ok: true,
      count: drivers.length,
      drivers,
    });
  } catch (err) {
    console.error("❌ getDrivers error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || String(err),
    });
  }
};

/**
 * ✅ Assign Company (Dummy placeholder)
 */
export const assignCompany = async (req, res) => {
  try {
    return res.json({
      ok: true,
      message: "assignCompany not implemented yet",
    });
  } catch (err) {
    console.error("❌ assignCompany error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || String(err),
    });
  }
};
