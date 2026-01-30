import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users" ;

/**
 * 🔥 Generic target resolver
 * - EVENT_ROLE_MAP based
 * - notificationPrefs respected (Map / List safe)
 * - Order specific users supported
 * - Distributor resolved via distributorCode
 */
export async function getTargetUsers(eventType, context = {}) {
  const allowedRoles = EVENT_ROLE_MAP[eventType];
  if (!allowedRoles) return [];

  const usersMap = new Map();

  /* --------------------------------------------------
   * 🔧 helper: extract prefs safely from DynamoDB
   * -------------------------------------------------- */
  const extractPrefs = (user, role) => {
    const raw = user.notificationPrefs?.[role];
    if (!raw) return [];

    // DocumentClient → already array
    if (Array.isArray(raw)) return raw;

    // Low-level DynamoDB format → { L: [{ S: "" }] }
    if (raw.L) return raw.L.map((x) => x.S);

    return [];
  };

  /* --------------------------------------------------
   * 1️⃣ GLOBAL USERS (Managers / mapped roles)
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

    const prefs = extractPrefs(u, role);
    if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

    if (u.playerIds?.length) {
      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 2️⃣ ORDER SPECIFIC USERS
   *   - Distributor (via distributorCode)
   *   - Driver (via driverMobile)
   *   - Creator (createdBy)
   * -------------------------------------------------- */
  if (context.order) {
    const { distributorId, driverMobile, createdBy } = context.order;

    /* ---- 2A️⃣ DISTRIBUTOR: distributorCode match ---- */
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
        const role = String(u.role || "").toUpperCase();
        if (!allowedRoles.includes(role)) continue;

        const prefs = extractPrefs(u, role);
        if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

        if (u.playerIds?.length) {
          usersMap.set(u.pk, u);
        }
      }
    }

    /* ---- 2B️⃣ DRIVER & CREATOR (mobile based) ---- */
    const fetchByMobile = async (mobile) => {
      if (!mobile) return null;
      const res = await ddb.send(
        new GetCommand({
          TableName: USERS_TABLE,
          Key: { pk: `USER#${mobile}`, sk: "PROFILE" },
        })
      );
      return res.Item;
    };

    const specialUsers = await Promise.all([
      fetchByMobile(driverMobile),
      fetchByMobile(createdBy),
    ]);

    for (const u of specialUsers) {
      if (!u?.playerIds?.length) continue;

      const role = String(u.role || "").toUpperCase();
      if (!allowedRoles.includes(role)) continue;

      const prefs = extractPrefs(u, role);
      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 3️⃣ FINAL UNIQUE USERS
   * -------------------------------------------------- */
  return [...usersMap.values()];
}
