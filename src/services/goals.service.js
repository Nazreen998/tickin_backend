import dayjs from "dayjs";
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const GOALS_TABLE = process.env.GOALS_TABLE || "tickin_goals";
const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || "tickin_products";

// ✅ monthKey = YYYY-MM
const monthKey = (month) => (month ? String(month) : dayjs().format("YYYY-MM"));

// ✅ PK/SK (Distributor + Product wise)
const goalPk = (distributorCode, month) =>
  `GOAL#${String(distributorCode).trim()}#${monthKey(month)}`;
const goalSk = (productId) => `PRODUCT#${String(productId).trim()}`;

// ✅ default goal per product per month
const DEFAULT_GOAL = 500;

// ✅ read all products from products table
async function getAllProducts() {
  const res = await ddb.send(
    new ScanCommand({
      TableName: PRODUCTS_TABLE,
      // your products.service.js uses active=true, அதையே follow பண்ணுறோம்
      FilterExpression: "active = :a",
      ExpressionAttributeValues: { ":a": true },
    })
  );

  return (res.Items || [])
    .map((p) => ({
      productId: String(p.productId || p.sk || "")
        .replace(/^P#/, "")
        .replace(/^PRODUCT#/, "")
        .trim(),
      name: String(p.name || "").trim(),
    }))
    .filter((p) => p.productId);
}

/**
 * ✅ Ensure monthly goals exist for ALL products for a distributor+month
 * If missing, create defaultGoal=500, used=0, remaining=500
 */
async function ensureMonthlyGoalsForDistributor({ distributorCode, month }) {
  const pk = goalPk(distributorCode, month);

  // existing goals for this distributor/month
  const existing = await ddb.send(
    new ScanCommand({
      TableName: GOALS_TABLE,
      FilterExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":sk": "PRODUCT#",
      },
    })
  );

  const existingSet = new Set(
    (existing.Items || []).map((x) =>
      String(x.productId || "").replace(/^P#/, "").trim()
    )
  );

  const products = await getAllProducts();
  const now = new Date().toISOString();

  for (const p of products) {
    if (existingSet.has(p.productId)) continue;

    const item = {
      pk,
      sk: goalSk(p.productId),
      distributorCode: String(distributorCode).trim(),
      month: monthKey(month),

      productId: p.productId,
      productName: p.name, // ✅ UI-la name kaata helpful

      defaultGoal: DEFAULT_GOAL,
      usedQty: 0,
      remainingQty: DEFAULT_GOAL,

      createdAt: now,
      updatedAt: now,
      active: true,
    };

    await ddb.send(
      new PutCommand({
        TableName: GOALS_TABLE,
        Item: item,
      })
    );
  }
}

/**
 * ✅ GET monthly goals for distributor (product-wise list)
 */
export async function getMonthlyGoalsForDistributor({ distributorCode, month }) {
  const pk = goalPk(distributorCode, month);

  await ensureMonthlyGoalsForDistributor({ distributorCode, month });

  const res = await ddb.send(
    new ScanCommand({
      TableName: GOALS_TABLE,
      FilterExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":sk": "PRODUCT#",
      },
    })
  );

  const goals = (res.Items || []).sort((a, b) =>
    String(a.productId || "").localeCompare(String(b.productId || ""))
  );

  return { goals };
}

/**
 * ✅ Deduct goals product-wise (order create / qty increase)
 * items: [{ productId, qty }]
 */
export async function deductDistributorMonthlyGoalProductWise({
  distributorCode,
  month,
  items,
}) {
  if (!items || !Array.isArray(items) || items.length === 0) return;

  const pk = goalPk(distributorCode, month);
  await ensureMonthlyGoalsForDistributor({ distributorCode, month });

  for (const it of items) {
    const productId = String(it.productId || "")
      .replace(/^P#/, "")
      .trim();
    const qty = Number(it.qty || 0);

    if (!productId || qty <= 0) continue;

    const sk = goalSk(productId);

    const existing = await ddb.send(
      new GetCommand({
        TableName: GOALS_TABLE,
        Key: { pk, sk },
      })
    );

    const rem = Number(existing.Item?.remainingQty ?? DEFAULT_GOAL);

    // ✅ goal must not go below 0
    if (rem - qty < 0) {
      throw new Error(
        `Goal exceeded for product ${productId}. Remaining=${rem}, trying=${qty}`
      );
    }

    await ddb.send(
      new UpdateCommand({
        TableName: GOALS_TABLE,
        Key: { pk, sk },
        UpdateExpression:
          "SET usedQty = if_not_exists(usedQty,:z) + :q, " +
          "remainingQty = if_not_exists(remainingQty,:d) - :q, " +
          "updatedAt = :u",
        ExpressionAttributeValues: {
          ":q": qty,
          ":u": new Date().toISOString(),
          ":z": 0,
          ":d": DEFAULT_GOAL,
        },
      })
    );
  }
}

/**
 * ✅ Add back goals product-wise (order update decrease / cancel)
 * items: [{ productId, qty }]
 */
export async function addBackDistributorMonthlyGoalProductWise({
  distributorCode,
  month,
  items,
}) {
  if (!items || !Array.isArray(items) || items.length === 0) return;

  const pk = goalPk(distributorCode, month);
  await ensureMonthlyGoalsForDistributor({ distributorCode, month });

  for (const it of items) {
    const productId = String(it.productId || "")
      .replace(/^P#/, "")
      .trim();
    const qty = Number(it.qty || 0);

    if (!productId || qty <= 0) continue;

    const sk = goalSk(productId);

    const existing = await ddb.send(
      new GetCommand({
        TableName: GOALS_TABLE,
        Key: { pk, sk },
      })
    );

    if (!existing.Item) continue;

    const used = Number(existing.Item.usedQty || 0);
    const rem = Number(existing.Item.remainingQty || 0);

    const newUsed = Math.max(used - qty, 0);
    const newRem = rem + qty;

    await ddb.send(
      new UpdateCommand({
        TableName: GOALS_TABLE,
        Key: { pk, sk },
        UpdateExpression:
          "SET usedQty = :u1, remainingQty = :r1, updatedAt = :u",
        ExpressionAttributeValues: {
          ":u1": newUsed,
          ":r1": newRem,
          ":u": new Date().toISOString(),
        },
      })
    );
  }
}

/**
 * ✅ BACKWARD COMPAT (old calls) - optional
 * But best: orders.service.js-la product-wise functions-a use pannunga.
 */
export async function deductDistributorMonthlyGoal({ distributorCode, qty, month }) {
  await deductDistributorMonthlyGoalProductWise({
    distributorCode,
    month,
    items: [{ productId: "UNKNOWN", qty }],
  });
}

export async function addBackDistributorMonthlyGoal({ distributorCode, qty, month }) {
  await addBackDistributorMonthlyGoalProductWise({
    distributorCode,
    month,
    items: [{ productId: "UNKNOWN", qty }],
  });
}
