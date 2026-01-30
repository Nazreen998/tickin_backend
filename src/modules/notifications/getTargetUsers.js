import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const USERS_TABLE = process.env.USERS_TABLE;

/**
 * 🔥 Generic target resolver
 * - EVENT_ROLE_MAP based
 * - notificationPrefs respected
 * - Order specific users supported (without duplication)
 */
export async function getTargetUsers(eventType, context = {}) {
  const allowedRoles = EVENT_ROLE_MAP[eventType];
  if (!allowedRoles) return [];

  const usersMap = new Map();

  /* --------------------------------------------------
   * 1️⃣ GLOBAL USERS (Managers / roles via EVENT_ROLE_MAP)
   * -------------------------------------------------- */
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: "#sk = :sk",
      ExpressionAttributeNames: {
        "#sk": "sk",
      },
      ExpressionAttributeValues: {
        ":sk": "PROFILE",
      },
    })
  );

  for (const u of scanRes.Items || []) {
    const role = String(u.role || "").toUpperCase();

    if (!allowedRoles.includes(role)) continue;

    const prefs = u.notificationPrefs?.[role] || [];
    if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

    if (u.playerIds?.length) {
      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 2️⃣ ORDER SPECIFIC USERS (Distributor / Driver / Creator)
   * -------------------------------------------------- */
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
      if (!allowedRoles.includes(role)) continue;

      const prefs = u.notificationPrefs?.[role] || [];
      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 3️⃣ FINAL UNIQUE USERS
   * -------------------------------------------------- */
  return [...usersMap.values()];
}
