import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

export const getOrderTimeline = async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await ddb.send(
      new QueryCommand({
        TableName: "tickin_timeline",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `ORDER#${orderId}`,
        },
        ScanIndexForward: true, // ascending order
      })
    );

    return res.json({
      message: "Timeline fetched",
      orderId,
      count: result.Items.length,
      timeline: result.Items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
