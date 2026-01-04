import { ddb } from "../config/dynamo.js";
import { ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const VEHICLES_TABLE = process.env.VEHICLES_TABLE || "tickin_vehicles";

// ✅ GET vehicles
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

// ✅ POST add vehicle
export const addVehicle = async (req, res) => {
  try {
    const { vehicleNo } = req.body;

    if (!vehicleNo) {
      return res.status(400).json({ ok: false, message: "vehicleNo required" });
    }

    const id = uuidv4().slice(0, 8);

    await ddb.send(
      new PutCommand({
        TableName: VEHICLES_TABLE,
        Item: {
          pk: `VEHICLE#${id}`,
          sk: "META",
          vehicleNo: String(vehicleNo).toUpperCase().trim(),
          createdAt: new Date().toISOString(),
        },
      })
    );

    return res.json({
      ok: true,
      message: "✅ Vehicle Added",
      vehicleNo,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
