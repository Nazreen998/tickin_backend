import "./env.js"; // 🔥 THIS IS THE FIX

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

console.log("DYNAMO ENV 👉", {
  region: process.env.AWS_REGION,
  key: process.env.AWS_ACCESS_KEY_ID,
});

export const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const ddb = DynamoDBDocumentClient.from(dynamoClient);
