import fs from "fs";
import csv from "csv-parser";
import { ddb } from "../config/dynamo.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DISTRIBUTORS_TABLE || "tickin_distributors";
const FILE = "./distributors.csv"; // ✅ place csv in project root

const run = async () => {
  const rows = [];

  fs.createReadStream(FILE)
    .pipe(csv())
    .on("data", (data) => rows.push(data))
    .on("end", async () => {
      console.log("✅ CSV Loaded:", rows.length);

      for (const r of rows) {
        const distributorCode = (r.distributorCode || r["Distributor Code"] || r["distributorCode"]).trim();
        const location = Number(r.Location || r["location"] || 0);
        const agencyName = r["Agency Name"] || r.agencyName || "";
        const area = r.Area || r.area || "";
        const phone = r["Phone Number"] || r.phone || "";

        if (!distributorCode) continue;

        const item = {
          pk: "DISTRIBUTOR",
          sk: distributorCode,
          distributorCode,
          location,
          agencyName,
          area,
          phone,
          active: true,
          createdAt: new Date().toISOString(),
        };

        try {
          await ddb.send(
            new PutCommand({
              TableName: TABLE,
              Item: item,
            })
          );
          console.log("✅ Inserted:", distributorCode, "loc:", location);
        } catch (err) {
          console.log("❌ Failed:", distributorCode, err.message);
        }
      }

      console.log("🎉 Import Completed");
    });
};

run();
