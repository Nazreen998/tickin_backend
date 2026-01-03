import { ddb } from "../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const VEHICLES_TABLE = process.env.VEHICLES_TABLE || "tickin_vehicle";

export const getAvailableVehicles = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: VEHICLES_TABLE,
      })
    );

    const vehicles = (result.Items || [])
      .map((v) => v.vehicleNo || v.vehicleNumber || v.number || v.regNo)
      .filter(Boolean);

    return res.json({ ok: true, count: vehicles.length, vehicles });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
