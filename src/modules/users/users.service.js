import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

// ✅ GET DRIVERS
export const getDrivers = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "#r = :driverRole",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":driverRole": "DRIVER" },
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
    const { mobile, companyId } = req.body;

    if (!mobile || !companyId) {
      return res.status(400).json({
        message: "mobile and companyId required",
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_users",
        Key: {
          pk: `USER#${mobile}`,
          sk: "PROFILE",
        },
        UpdateExpression: "SET companyId = :c",
        ExpressionAttributeValues: {
          ":c": companyId,
        },
      })
    );

    res.json({
      message: "Company assigned successfully",
      mobile,
      companyId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
