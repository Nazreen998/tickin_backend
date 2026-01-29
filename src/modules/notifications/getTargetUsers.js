import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const USERS_TABLE = process.env.USERS_TABLE;

/**
 * 🔥 Generic target resolver
 * - Uses EVENT_ROLE_MAP
 * - Uses notificationPrefs
 * - Supports order based targeting
 */
export async function getTargetUsers(eventType, context = {}) {
  const allowedRoles = EVENT_ROLE_MAP[eventType];
  if (!allowedRoles) return [];

  const users = [];

  /* 1️⃣ Scan all profiles */
  const out = await ddb.send(
    new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: "sk = :sk",
      ExpressionAttributeValues: {
        ":sk": "PROFILE",
      },
    })
  );

  for (const u of out.Items || []) {
    const role = String(u.role || "").toUpperCase();

    if (!allowedRoles.includes(role)) continue;

    const prefs = u.notificationPrefs?.[role] || [];

    if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

    users.push(u);
  }

  /* 2️⃣ Order specific users (Distributor / Driver / Creator) */
  if (context.order) {
    const { distributorId, driverMobile, createdBy } = context.order;

    const fetchUser = async (id) => {
      if (!id) return null;
      const res = await ddb.send(
        new GetCommand({
          TableName: USERS_TABLE,
          Key: { pk: `USER#${id}`, sk: "PROFILE" },
        })
      );
      return res.Item;
    };

    const specialUsers = await Promise.all([
      fetchUser(distributorId),
      fetchUser(driverMobile),
      fetchUser(createdBy),
    ]);

    for (const u of specialUsers) {
      if (!u?.playerIds?.length) continue;

      const role = String(u.role || "").toUpperCase();
      const prefs = u.notificationPrefs?.[role] || [];

      if (prefs.includes("ALL") || prefs.includes(eventType)) {
        users.push(u);
      }
    }
  }

  /* 3️⃣ Deduplicate */
  const uniq = new Map();
  for (const u of users) uniq.set(u.pk, u);

  return [...uniq.values()];
}
