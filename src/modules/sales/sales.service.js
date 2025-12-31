import { ddb } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

// ✅ Get distributors for Sales Officer allowed codes
export const getDistributorsByCodes = async (codes = []) => {
  if (!codes.length) return [];

  const params = {
    TableName: "tickin_distributors",
    FilterExpression:
      "distributorCode IN (" +
      codes.map((_, i) => `:c${i}`).join(",") +
      ")",
    ExpressionAttributeValues: codes.reduce((acc, c, i) => {
      acc[`:c${i}`] = c;
      return acc;
    }, {}),
  };

  const result = await ddb.send(new ScanCommand(params));
  return result.Items || [];
};

// ✅ Get ALL distributors for Manager
export const getAllDistributors = async () => {
  const params = { TableName: "tickin_distributors" };
  const result = await ddb.send(new ScanCommand(params));
  return result.Items || [];
};
