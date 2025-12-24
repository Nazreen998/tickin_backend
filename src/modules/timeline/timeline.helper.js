import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

export const addTimelineEvent = async ({ orderId, event, by, extra = {} }) => {
  const timestamp = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: "tickin_timeline",
      Item: {
        pk: `ORDER#${orderId}`,
        sk: `TIME#${timestamp}`,
        orderId,
        event,
        by,
        timestamp,
        ...extra,
      },
    })
  );

  return true;
};
