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
 * ✅ Distributor wise PK (matches your DynamoDB)
 * pk = GOAL#D024#2025-12
 * sk = PRODUCT#1015
 */
const buildGoalKeys = ({ distributorCode, productId, monthKey }) => ({
  pk: `GOAL#${distributorCode}#${monthKey}`,
  sk: `PRODUCT#${productId}`,
});

/**
 * ✅ Deduct goal when order confirmed (Distributor-wise + Product-wise)
 * distributorCode = D001 / D024 / D028 etc
 */
export const deductMonthlyGoal = async ({
  distributorCode,
  productId,
  qty,
  month,
}) => {
  if (!distributorCode || !productId) {
    throw new Error("distributorCode & productId required");
  }

  if (!qty || qty <= 0) {
    throw new Error("qty must be > 0");
  }

  const monthKey = getMonthKey(month);
  const { pk, sk } = buildGoalKeys({ distributorCode, productId, monthKey });
  const now = new Date().toISOString();
  qty = Number(qty);

  /**
   * ✅ 1) Ensure record exists
   * If not exists -> create with defaultGoal = 500
   */
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
            active: true,
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        })
      );
    } catch (e) {
      // ignore race condition (another request might have created it)
    }
  }

  /**
   * ✅ OPTIONAL (Recommended):
   * Prevent remainingQty from going negative by checking current remaining
   */
  const currentRemaining = existing.Item
    ? Number(existing.Item.remainingQty ?? DEFAULT_GOAL)
    : DEFAULT_GOAL;

  if (qty > currentRemaining) {
    throw new Error(`Goal exceeded. Remaining: ${currentRemaining}`);
  }

  /**
   * ✅ 2) Atomic update usedQty + remainingQty (SINGLE UPDATE ✅)
   * remainingQty is recalculated automatically:
   * remainingQty = defaultGoal - (usedQty + qty)
   *
   * ✅ No second update required.
   */
  const updateRes = await ddb.send(
    new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
      UpdateExpression: `
        SET 
          defaultGoal = if_not_exists(defaultGoal, :goal),
          usedQty = if_not_exists(usedQty, :zero) + :qty,
          remainingQty = if_not_exists(defaultGoal, :goal) - (if_not_exists(usedQty, :zero) + :qty),
          updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ":goal": DEFAULT_GOAL,
        ":zero": 0,
        ":qty": qty,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return updateRes.Attributes;
};

/**
 * ✅ Get Monthly goals for Distributor
 * pk = GOAL#D024#2025-12
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
