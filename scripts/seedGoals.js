import { ddb } from "../src/config/dynamo.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.GOALS_TABLE || "tickin_goals";

// ✅ Month Key auto generate (YYYY-MM)
const getMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ✅ Distributor Codes (D001 to D033)
const distributors = [
  "D001","D002","D003","D004","D005","D006","D007","D008","D009","D010",
  "D011","D012","D013","D014","D015","D016","D017","D018","D019","D020",
  "D021","D022","D023","D024","D025","D026","D027","D028","D029","D030",
  "D031","D032","D033"
];

// ✅ 19 Products
const products = [
  "1001","1002","1003","1004","1005","1006","1007","1008","1009","1010",
  "1011","1012","1013","1014","1015","1016","1017","1018","1019"
];

const run = async () => {
  const monthKey = getMonthKey();
  console.log("🚀 Seeding goals for month:", monthKey);

  let success = 0;
  let failed = 0;

  for (const distributorId of distributors) {
    for (const productId of products) {

      const pk = `GOAL#${distributorId}#${monthKey}`;
      const sk = `PRODUCT#${productId}`;

      const item = {
        pk,
        sk,
        distributorId,
        month: monthKey,
        productId,
        defaultGoal: 500,
        usedQty: 0,
        remainingQty: 500,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      try {
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: item,
          })
        );

        success++;
        console.log("✅ Inserted:", pk, sk);
      } catch (err) {
        failed++;
        console.log("❌ Failed:", pk, sk, err.message);
      }
    }
  }

  console.log("🎉 Done!");
  console.log("✅ Success:", success);
  console.log("❌ Failed:", failed);
  console.log("📌 Total expected:", distributors.length * products.length); // 627
};

run();
