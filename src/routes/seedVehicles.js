import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./src/config/dynamo.js";

const TABLE = "tickin_vehicles";

const vehicles = [
  { vehicleNo: "TN64AD4438", driverName: "KATHAVARAYAN" },
  { vehicleNo: "TN64AD4428", driverName: "VENKADESH" },
  { vehicleNo: "TN64AD4420", driverName: "ARUN" },
  { vehicleNo: "TN64AD4430", driverName: "SITHIK" }
];

async function seed() {
  for (const v of vehicles) {
    const item = {
      pk: `VEHICLE#${v.vehicleNo}`,
      sk: "META",
      vehicleNo: v.vehicleNo,
      driverName: v.driverName,
      status: "ACTIVE",
      createdAt: new Date().toISOString()
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    console.log("✅ Added:", v.vehicleNo);
  }
}

seed();
