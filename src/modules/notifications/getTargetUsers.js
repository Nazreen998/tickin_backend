import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";

/**
 * 🔥 FINAL Notification Target Resolver
 * - MANAGER → global
 * - Others → orders based
 * - notificationPrefs respected
 * - duplicates avoided
 */
export async function getTargetUsers(eventType) {
  const allowedRoles = EVENT_ROLE_MAP[eventType];
  if (!allowedRoles) return [];

  const usersMap = new Map();

  /* --------------------------------------------------
   * 🔧 helper: extract notification prefs safely
   * -------------------------------------------------- */
  const extractPrefs = (user, role) => {
    const raw = user.notificationPrefs?.[role];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.L) return raw.L.map((x) => x.S);
    return [];
  };

  /* --------------------------------------------------
   * 🔧 helper: get user by mobile
   * -------------------------------------------------- */
  const getUserByMobile = async (mobile) => {
    if (!mobile) return null;
    const res = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: `USER#${mobile}`, sk: "PROFILE" },
      })
    );
    return res.Item;
  };

  /* --------------------------------------------------
   * 1️⃣ GLOBAL USERS (MANAGER)
   * -------------------------------------------------- */
  if (allowedRoles.includes("MANAGER")) {
    const managerScan = await ddb.send(
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

    for (const u of managerScan.Items || []) {
      if (String(u.role) !== "MANAGER") continue;
      if (!u.playerIds?.length) continue;

      const prefs = extractPrefs(u, "MANAGER");
      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 2️⃣ SCAN ORDERS TABLE
   * -------------------------------------------------- */
  const orderScan = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
    })
  );

  /* --------------------------------------------------
   * 3️⃣ ORDER BASED USERS
   * -------------------------------------------------- */
  for (const order of orderScan.Items || []) {
    const { distributorId, driverMobile, createdBy } = order;

    /* ---- DRIVER & CREATOR ---- */
    const mobileUsers = await Promise.all([
      getUserByMobile(driverMobile),
      getUserByMobile(createdBy),
    ]);

    for (const u of mobileUsers) {
      if (!u?.playerIds?.length) continue;

      const role = String(u.role || "");
      if (!allowedRoles.includes(role)) continue;

      const prefs = extractPrefs(u, role);
      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      usersMap.set(u.pk, u);
    }

    /* ---- DISTRIBUTOR USERS ---- */
    if (distributorId) {
      const distributorScan = await ddb.send(
        new ScanCommand({
          TableName: USERS_TABLE,
          FilterExpression: "#sk = :sk AND distributorCode = :dc",
          ExpressionAttributeNames: {
            "#sk": "sk",
          },
          ExpressionAttributeValues: {
            ":sk": "PROFILE",
            ":dc": distributorId,
          },
        })
      );

      for (const u of distributorScan.Items || []) {
        if (!u.playerIds?.length) continue;

        const role = String(u.role || "");
        if (!allowedRoles.includes(role)) continue;

        const prefs = extractPrefs(u, role);
        if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

        usersMap.set(u.pk, u);
      }
    }
  }

  /* --------------------------------------------------
   * 4️⃣ FINAL UNIQUE USERS
   * -------------------------------------------------- */
  return [...usersMap.values()];
}
