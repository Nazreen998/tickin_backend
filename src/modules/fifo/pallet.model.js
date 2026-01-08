import { ddb } from "../../utils/dynamo.js";
import { PutCommand, GetCommand, UpdateCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.PALLET_TABLE;

/**
 * PK: PALLET#{palletId}
 * SK: META
 * GSI1PK: PRODUCT#{productCode}
 * GSI1SK: MFG#{mfgDate}#PALLET#{palletId}
 */

export const Pallet = {
  async getById(palletId) {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: {
        PK: `PALLET#${palletId}`,
        SK: "META"
      }
    }));
    return res.Item;
  },

  async create(data) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      ConditionExpression: "attribute_not_exists(PK)",
      Item: {
        PK: `PALLET#${data.palletId}`,
        SK: "META",
        GSI1PK: `PRODUCT#${data.productCode}`,
        GSI1SK: `MFG#${data.mfgDate}#PALLET#${data.palletId}`,
        ...data,
        remainingCases: data.totalCases,
        createdAt: new Date().toISOString()
      }
    }));
  },

  async consume(palletId, consumeCases) {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `PALLET#${palletId}`,
        SK: "META"
      },
      ConditionExpression: "remainingCases >= :c",
      UpdateExpression: "SET remainingCases = remainingCases - :c",
      ExpressionAttributeValues: {
        ":c": consumeCases
      },
      ReturnValues: "ALL_NEW"
    }));
    return res.Attributes;
  },

  async delete(palletId) {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: {
        PK: `PALLET#${palletId}`,
        SK: "META"
      }
    }));
  },

  async fifoByProduct(productCode) {
    const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    FilterExpression: "remainingCases > :z",
    ExpressionAttributeValues: {
        ":pk": `PRODUCT#${productCode}`,
        ":z": 0
    },
     ScanIndexForward: true // 👈 FIFO (oldest first)
    }));

    return res.Items || [];
  }
};
