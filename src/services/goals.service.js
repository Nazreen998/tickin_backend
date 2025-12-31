import { ddb } from "../config/dynamo.js";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const GOALS_TABLE = process.env.GOALS_TABLE || "tickin_goals";
const DEFAULT_GOAL = 500;

const getMonthKey = (month) => {
  if (month) return month;
  const now = new Date();
  const year = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${m}`;
};

const buildKeys = ({ distributorCode, monthKey }) => ({
  pk: `GOAL#${distributorCode}#${monthKey}`,
  sk: "META",
});

// ✅ Ensure distributor record exists for current month
const ensureGoalRecord = async ({ distributorCode, monthKey }) => {
  const { pk, sk } = buildKeys({ distributorCode, monthKey });
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: GOALS_TABLE,
      Item: {
        pk,
        sk,
        distributorCode,
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
  ).catch(() => {});
};

// ✅ Deduct goal when order is created (PENDING stage)
export const deductDistributorMonthlyGoal = async ({ distributorCode, qty, month }) => {
  if (!distributorCode) throw new Error("distributorCode required");
  if (!qty || qty <= 0) throw new Error("qty must be > 0");

  const monthKey = getMonthKey(month);
  const { pk, sk } = buildKeys({ distributorCode, monthKey });
  const now = new Date().toISOString();
  const amount = Number(qty);

  await ensureGoalRecord({ distributorCode, monthKey });

  const res = await ddb.send(
    new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
      ConditionExpression: "remainingQty >= :qty",
      UpdateExpression:
        "SET usedQty = if_not_exists(usedQty,:zero) + :qty, " +
        "remainingQty = if_not_exists(remainingQty,:goal) - :qty, " +
        "updatedAt = :now",
      ExpressionAttributeValues: {
        ":goal": DEFAULT_GOAL,
        ":zero": 0,
        ":qty": amount,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return res.Attributes;
};

// ✅ Add back goal if order edited reduced qty / deleted
export const addBackDistributorMonthlyGoal = async ({ distributorCode, qty, month }) => {
  if (!distributorCode) throw new Error("distributorCode required");
  if (!qty || qty <= 0) throw new Error("qty must be > 0");

  const monthKey = getMonthKey(month);
  const { pk, sk } = buildKeys({ distributorCode, monthKey });
  const now = new Date().toISOString();
  const amount = Number(qty);

  await ensureGoalRecord({ distributorCode, monthKey });

  // ✅ Prevent usedQty from going negative
  const res = await ddb.send(
    new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
      UpdateExpression:
        "SET usedQty = if_not_exists(usedQty,:zero) - :qty, " +
        "remainingQty = if_not_exists(remainingQty,:goal) + :qty, " +
        "updatedAt = :now",
      ExpressionAttributeValues: {
        ":goal": DEFAULT_GOAL,
        ":zero": 0,
        ":qty": amount,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return res.Attributes;
};

// ✅ GET monthly goals (returns META record)
export const getMonthlyGoalsForDistributor = async ({ distributorCode, month }) => {
  if (!distributorCode) throw new Error("distributorCode required");

  const monthKey = getMonthKey(month);
  const { pk, sk } = buildKeys({ distributorCode, monthKey });

  await ensureGoalRecord({ distributorCode, monthKey });

  const res = await ddb.send(
    new GetCommand({
      TableName: GOALS_TABLE,
      Key: { pk, sk },
    })
  );

  return {
    distributorCode,
    month: monthKey,
    goals: res.Item ? [res.Item] : [],
  };
};
