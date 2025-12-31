import { docClient } from "../../config/dynamo.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

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

  const result = await docClient.send(new ScanCommand(params));
  return result.Items || [];
};
