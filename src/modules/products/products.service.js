import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

export const listProducts = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_products",
        FilterExpression: "active = :a",
        ExpressionAttributeValues: {
          ":a": true
        }
      })
    );

    return res.json({
      message: "Products fetched ✅",
      count: result.Items?.length || 0,
      products: result.Items || []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
