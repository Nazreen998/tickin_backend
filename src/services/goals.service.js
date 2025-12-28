import { ddb } from "../config/dynamo.js";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const GOALS_TABLE = process.env.GOALS_TABLE || "tickin_goals";
const DEFAULT_GOAL = 500;

const getMonthKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const buildGoalKeys = ({ salesmanId, productId, monthKey }) => ({
  pk: `GOAL#${salesmanId}#${monthKey}`,
  sk: `PRODUCT#${productId}`,
});

export const deductMonthlyGoal = async ({ salesmanId, productId, qty }) => {
  if (!salesmanId || !productId) throw new Error("salesmanId & productId required");
  if (!qty || qty <= 0) throw new Error("qty must be > 0");

  const monthKey = getMonthKey();
  const { pk, sk } = buildGoalKeys({ salesmanId, productId, monthKey });
  const now = new Date().toISOString();

  // ✅ 1) Ensure record exists (create if not exists)
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
            salesmanId,
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

  // ✅ 3) Calculate remainingQty safely (never negative)
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

export const getMonthlyGoalsForSalesman = async ({ salesmanId }) => {
  if (!salesmanId) throw new Error("salesmanId required");

  const monthKey = getMonthKey();
  const pk = `GOAL#${salesmanId}#${monthKey}`;

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
    salesmanId,
    month: monthKey,
    goals: res.Items || [],
  };
};
