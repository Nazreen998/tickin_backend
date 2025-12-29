import { ddb } from "../config/dynamo.js";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const GOALS_TABLE = process.env.GOALS_TABLE || "tickin_goals";
const DEFAULT_GOAL = 500;

/**
 * ✅ MonthKey format: YYYY-MM
 * month optional param: 2025-12
 */
const getMonthKey = (month) => {
  if (month) return month;
  const now = new Date();
  const year = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${m}`;
};

/**
 * ✅ Distributor wise PK
 */
const buildGoalKeys = ({ distributorCode, productId, monthKey }) => ({
  pk: `GOAL#${distributorCode}#${monthKey}`,
  sk: `PRODUCT#${productId}`,
});

/**
 * ✅ Deduct goal when order confirmed
 */
export const deductMonthlyGoal = async ({
  distributorCode,
  productId,
  qty,
  month,
}) => {
  if (!distributorCode || !productId)
    throw new Error("distributorCode & productId required");
  if (!qty || qty <= 0) throw new Error("qty must be > 0");

  const monthKey = getMonthKey(month);
  const { pk, sk } = buildGoalKeys({ distributorCode, productId, monthKey });
  const now = new Date().toISOString();

  // ✅ 1) Ensure record exists
  const existing = await ddb.send(
    new GetCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
    })
  );

  if (!existing.Item) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: GOALS_TABLE,
          Item: {
            pk,
            sk,
            distributorCode,
            productId,
            month: monthKey,
            defaultGoal: DEFAULT_GOAL,
            usedQty: 0,
            remainingQty: DEFAULT_GOAL,
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
    } catch (e) {
      // ignore race condition
    }
  }

  // ✅ 2) Atomic update usedQty
  const updateRes = await ddb.send(
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

  const updated = updateRes.Attributes;

  // ✅ 3) remainingQty never negative
  const remaining = Math.max(
    0,
    (updated.defaultGoal || DEFAULT_GOAL) - (updated.usedQty || 0)
  );

  // ✅ 4) Save remainingQty
  const finalRes = await ddb.send(
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

  return finalRes.Attributes;
};

/**
 * ✅ Get Monthly goals for Distributor
 */
export const getMonthlyGoalsForDistributor = async ({
  distributorCode,
  month,
}) => {
  if (!distributorCode) throw new Error("distributorCode required");

  const monthKey = getMonthKey(month);
  const pk = `GOAL#${distributorCode}#${monthKey}`;

  const res = await ddb.send(
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
    distributorCode,
    month: monthKey,
    goals: res.Items || [],
  };
};
