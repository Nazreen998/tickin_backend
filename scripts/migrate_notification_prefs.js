import "dotenv/config";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "ap-south-1";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

const DEFAULT_NOTIFICATION_PREFS = {
  MANAGER: ["ORDER_CREATED", "SLOT_BOOKING_COMPLETED"],
  SALES_OFFICER: [
    "ORDER_CREATED",
    "SLOT_BOOKING_COMPLETED",
    "DELIVERY_COMPLETED",
  ],
  DISTRIBUTOR: ["ALL"],
  DRIVER: ["DRIVER_ASSIGNED", "DRIVE_STARTED"],"SALES OFFICER": [
    "ORDER_CREATED",
    "SLOT_BOOKING_COMPLETED",
    "DELIVERY_COMPLETED",
  ],

  "SALES OFFICER_VNR": [
    "ORDER_CREATED",
    "SLOT_BOOKING_COMPLETED",
    "DELIVERY_COMPLETED",
  ],
  "SALES_OFFICER_VNR": [
    "ORDER_CREATED",
    "SLOT_BOOKING_COMPLETED",
    "DELIVERY_COMPLETED",
  ],

};

async function migrate() {
  console.log("🚀 Starting notificationPrefs migration");
  console.log("-------------------------------------");

  let lastKey;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        ExclusiveStartKey: lastKey,
        ProjectionExpression: "pk, sk, #r, notificationPrefs",
        ExpressionAttributeNames: {
          "#r": "role",
        },
        Limit: 25,
      })
    );

    for (const user of scan.Items || []) {
      scanned++;

      const pk = user.pk;
      const sk = user.sk;
      const role = String(user.role || "").toUpperCase();

      /* 🔴 SKIP REASON 1: Not PROFILE */
      if (sk !== "PROFILE") {
        skipped++;
        console.log(`⏭ SKIP ${pk} → sk=${sk} (not PROFILE)`);
        continue;
      }

      const prefs = DEFAULT_NOTIFICATION_PREFS[role];

      /* 🔴 SKIP REASON 2: Unknown role */
      if (!prefs) {
        skipped++;
        console.log(`⏭ SKIP ${pk} → unknown role=${role}`);
        continue;
      }

      /* 🔴 SKIP REASON 3: Already migrated */
      if (user.notificationPrefs?.[role]) {
        skipped++;
        console.log(
          `⏭ SKIP ${pk} → already has prefs for role=${role}`
        );
        continue;
      }

      try {
        // STEP 1: ensure map exists
        if (!user.notificationPrefs) {
          await ddb.send(
            new UpdateCommand({
              TableName: USERS_TABLE,
              Key: { pk, sk },
              UpdateExpression: "SET notificationPrefs = :empty",
              ExpressionAttributeValues: {
                ":empty": {},
              },
              ConditionExpression:
                "attribute_not_exists(notificationPrefs)",
            })
          );
        }

        // STEP 2: set role prefs
        await ddb.send(
          new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { pk, sk },
            UpdateExpression:
              "SET notificationPrefs.#role = :prefs",
            ExpressionAttributeNames: {
              "#role": role,
            },
            ExpressionAttributeValues: {
              ":prefs": prefs,
            },
          })
        );

        updated++;
        console.log(`✅ UPDATED ${pk} (${role})`);
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
          // retry step 2
          try {
            await ddb.send(
              new UpdateCommand({
                TableName: USERS_TABLE,
                Key: { pk, sk },
                UpdateExpression:
                  "SET notificationPrefs.#role = :prefs",
                ExpressionAttributeNames: {
                  "#role": role,
                },
                ExpressionAttributeValues: {
                  ":prefs": prefs,
                },
              })
            );
            updated++;
            console.log(`✅ UPDATED ${pk} (${role})`);
          } catch (e2) {
            console.error(`❌ FAILED ${pk}`, e2.message);
          }
        } else {
          console.error(`❌ FAILED ${pk}`, err.message);
        }
      }
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log("-------------------------------------");
  console.log("🎉 Migration completed");
  console.log("🔍 Scanned :", scanned);
  console.log("✅ Updated :", updated);
  console.log("⏭ Skipped :", skipped);
}

migrate()
  .then(() => {
    console.log("✅ DONE");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Migration crashed:", err);
    process.exit(1);
  });
