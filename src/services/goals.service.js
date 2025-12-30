import { ddb } from "../config/dynamo.js";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const GOALS_TABLE = process.env.GOALS_TABLE || "tickin_goals";
const DEFAULT_GOAL = 500;

const getMonthKey = (month) => {
  if (month) return month;
  const now = new Date();
  const year = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${m}`;
};

const buildGoalKeys = ({ distributorCode, productId, monthKey }) => ({
  pk: `GOAL#${distributorCode}#${monthKey}`,
  sk: `PRODUCT#${productId}`,
});

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

  // ✅ Ensure record exists
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
            productId: String(productId),
            month: monthKey,
            defaultGoal: DEFAULT_GOAL,
            usedQty: 0,
            remainingQty: DEFAULT_GOAL,
            createdAt: now,
            updatedAt: now,
            active: true,
          },
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        })
      );
    } catch (e) {
      // ignore race condition
    }
  }

  // ✅ Prevent goal going negative
  const currentRemaining = existing.Item
    ? Number(existing.Item.remainingQty ?? DEFAULT_GOAL)
    : DEFAULT_GOAL;

  if (qty > currentRemaining) {
    throw new Error(`Goal exceeded. Remaining: ${currentRemaining}`);
  }

  /**
   * ✅ SINGLE UpdateExpression
   * ✅ NO backticks
   * ✅ NO escaping "\+\"
   */
  console.log("✅ deductMonthlyGoal called", { distributorCode, productId, qty });
  const updateRes = await ddb.send(
  new UpdateCommand({
    TableName: GOALS_TABLE,
    Key: { pk, sk },
    ConditionExpression: "remainingQty >= :qty OR attribute_not_exists(remainingQty)",
    UpdateExpression:
      "SET defaultGoal = if_not_exists(defaultGoal, :goal), " +
      "usedQty = if_not_exists(usedQty, :zero) + :qty, " +
      "remainingQty = if_not_exists(remainingQty, :goal) - :qty, " +
      "updatedAt = :now",
    ExpressionAttributeValues: {
      ":goal": DEFAULT_GOAL,
      ":zero": 0,
      ":qty": Number(qty),
      ":now": now,
    },
    ReturnValues: "ALL_NEW",
  })
);
return updateRes.Attributes;
};

export const getMonthlyGoalsForDistributor = async ({ distributorCode, month }) => {
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
