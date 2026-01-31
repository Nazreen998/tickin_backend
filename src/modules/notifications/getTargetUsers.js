import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { EVENT_ROLE_MAP } from "../../config/notificationEvents.js";

const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";

export async function getTargetUsers(eventType) {
  console.log("🧪 DEBUG: eventType =", eventType);

  const allowedRoles = EVENT_ROLE_MAP[eventType];
  console.log("🧪 DEBUG: allowedRoles =", allowedRoles);

  if (!allowedRoles) return [];

  const getRoleVariants = (role) => {
    const raw = String(role || "").toUpperCase();
    if (!raw) return [];
    const variants = new Set([
      raw,
      raw.replace(/_/g, " "),
      raw.replace(/\s+/g, "_"),
    ]);
    return [...variants];
  };

  const usersMap = new Map();

  /* --------------------------------------------------
   * helper: extract prefs
   * -------------------------------------------------- */
  const extractPrefs = (user, role) => {
    const rawPrefs = user.notificationPrefs;
    if (Array.isArray(rawPrefs)) {
      console.log(
        "🧪 DEBUG: extractPrefs (flat)",
        user.pk,
        role,
        rawPrefs
      );
      return rawPrefs;
    }

    const roleVariants = getRoleVariants(role);
    for (const roleKey of roleVariants) {
      const raw = rawPrefs?.[roleKey];
      console.log("🧪 DEBUG: extractPrefs", user.pk, roleKey, raw);

      if (!raw) continue;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") return [raw];
      if (raw.L) return raw.L.map((x) => x.S);
      if (raw.S) return [raw.S];
    }
    return [];
  };

  /* --------------------------------------------------
   * helper: get user by mobile
   * -------------------------------------------------- */
  const getUserByMobile = async (mobile) => {
    console.log("🧪 DEBUG: getUserByMobile called with", mobile);

    if (!mobile) return null;

    const res = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: `USER#${mobile}`, sk: "PROFILE" },
      })
    );

    console.log(
      "🧪 DEBUG: getUserByMobile result",
      res.Item?.pk || "NOT FOUND"
    );

    return res.Item;
  };

  /* --------------------------------------------------
   * 1️⃣ MANAGER USERS
   * -------------------------------------------------- */
  if (allowedRoles.includes("MANAGER")) {
    console.log("🧪 DEBUG: scanning MANAGER users");

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

    console.log(
      "🧪 DEBUG: managerScan count =",
      managerScan.Items?.length
    );

    for (const u of managerScan.Items || []) {
      console.log("🧪 DEBUG: checking user", u.pk, u.role);

      if (String(u.role) !== "MANAGER") continue;
      if (!u.playerIds?.length) continue;

      const prefs = extractPrefs(u, "MANAGER");
      console.log("🧪 DEBUG: MANAGER prefs =", prefs);

      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      console.log("🧪 DEBUG: MANAGER added", u.pk);
      usersMap.set(u.pk, u);
    }
  }

  /* --------------------------------------------------
   * 2️⃣ SCAN ORDERS
   * -------------------------------------------------- */
  console.log("🧪 DEBUG: scanning ORDERS table");

  const orderScan = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
    })
  );

  console.log(
    "🧪 DEBUG: orders count =",
    orderScan.Items?.length
  );

  /* --------------------------------------------------
   * 3️⃣ ORDER BASED USERS
   * -------------------------------------------------- */
  for (const order of orderScan.Items || []) {
    const { distributorId, driverMobile, createdBy } = order;

    console.log("🧪 DEBUG: order =", {
      distributorId,
      driverMobile,
      createdBy,
    });

    /* ---- DRIVER & CREATOR ---- */
    const mobileUsers = await Promise.all([
      getUserByMobile(driverMobile),
      getUserByMobile(createdBy),
    ]);

    for (const u of mobileUsers) {
      if (!u) continue;

      console.log("🧪 DEBUG: mobile user found", u.pk, u.role);

      if (!u.playerIds?.length) continue;

      const role = String(u.role || "");
      const roleVariants = getRoleVariants(role);
      if (!roleVariants.some((r) => allowedRoles.includes(r))) continue;

      const prefs = extractPrefs(u, role);
      console.log("🧪 DEBUG: mobile user prefs =", prefs);

      if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

      console.log("🧪 DEBUG: mobile user added", u.pk);
      usersMap.set(u.pk, u);
    }

    /* ---- DISTRIBUTOR ---- */
    if (distributorId) {
      console.log("🧪 DEBUG: scanning distributor", distributorId);

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

      console.log(
        "🧪 DEBUG: distributorScan count =",
        distributorScan.Items?.length
      );

      for (const u of distributorScan.Items || []) {
        console.log(
          "🧪 DEBUG: distributor user",
          u.pk,
          u.role
        );

        if (!u.playerIds?.length) continue;

        const role = String(u.role || "");
        const roleVariants = getRoleVariants(role);
        if (!roleVariants.some((r) => allowedRoles.includes(r))) continue;

        const prefs = extractPrefs(u, role);
        console.log("🧪 DEBUG: distributor prefs =", prefs);

        if (!(prefs.includes("ALL") || prefs.includes(eventType))) continue;

        console.log("🧪 DEBUG: distributor user added", u.pk);
        usersMap.set(u.pk, u);
      }
    }
  }

  /* --------------------------------------------------
   * 4️⃣ FINAL
   * -------------------------------------------------- */
  console.log("🧪 DEBUG: FINAL USERS =", [...usersMap.keys()]);

  return [...usersMap.values()];
}
