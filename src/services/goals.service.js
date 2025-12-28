import { docClient } from "../config/dynamo.js";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const GOALS_TABLE = process.env.GOALS_TABLE || "TickinGoals";
const DEFAULT_GOAL = 500;

/**
 * helper to get current month key: YYYY-MM
 */
const getMonthKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

/**
 * Salesman-wise, Month-wise, Product-wise goal record key
 * pk = GOAL#<salesmanId>#<YYYY-MM>
 * sk = PRODUCT#<productId>
 */
const buildGoalKeys = ({ salesmanId, productId, monthKey }) => {
  return {
    pk: `GOAL#${salesmanId}#${monthKey}`,
    sk: `PRODUCT#${productId}`,
  };
};

/**
 * ✅ Deduct monthly goal when salesman confirms an order
 * - Create record if not exists with defaultGoal=500
 * - usedQty += qty
 * - remainingQty = max(0, defaultGoal - usedQty)
 */
export const deductMonthlyGoal = async ({ salesmanId, productId, qty }) => {
  if (!salesmanId || !productId) throw new Error("salesmanId & productId required");
  if (!qty || qty <= 0) throw new Error("qty must be > 0");

  const monthKey = getMonthKey();
  const { pk, sk } = buildGoalKeys({ salesmanId, productId, monthKey });
  const now = new Date().toISOString();

  // 1) Ensure goal record exists (create once per month per product)
  const existing = await docClient.send(
    new GetCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
    })
  );

  if (!existing.Item) {
    await docClient.send(
      new PutCommand({
        TableName: GOALS_TABLE,
        Item: {
          pk,
          sk,
          salesmanId,
          productId,
          month: monthKey,
          defaultGoal: DEFAULT_GOAL,
          usedQty: 0,
          remainingQty: DEFAULT_GOAL,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)", // prevent double create
      }).catch(() => {}) // ignore create race
    );
  }

  // 2) Atomic update usedQty and remainingQty
  const updateRes = await docClient.send(
    new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
      UpdateExpression: `
        SET
          defaultGoal = if_not_exists(defaultGoal, :goal),
          usedQty = if_not_exists(usedQty, :zero) + :qty,
          updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ":goal": DEFAULT_GOAL,
        ":zero": 0,
        ":qty": Number(qty),
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  let updated = updateRes.Attributes;

  // 3) Calculate remainingQty in safe way (never negative)
  const remaining = Math.max(0, (updated.defaultGoal || DEFAULT_GOAL) - (updated.usedQty || 0));

  // 4) Update remainingQty
  const remainingRes = await docClient.send(
    new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
      UpdateExpression: "SET remainingQty = :remaining",
      ExpressionAttributeValues: {
        ":remaining": remaining,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return remainingRes.Attributes;
};

/**
 * ✅ Get current month goals for a salesman
 */
export const getMonthlyGoalsForSalesman = async ({ salesmanId }) => {
  if (!salesmanId) throw new Error("salesmanId required");

  const monthKey = getMonthKey();
  const pk = `GOAL#${salesmanId}#${monthKey}`;

  const res = await docClient.send(
    new QueryCommand({
      TableName: GOALS_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": pk,
      },
      ScanIndexForward: true,
    })
  );

  return {
    salesmanId,
    month: monthKey,
    goals: res.Items || [],
  };
};
