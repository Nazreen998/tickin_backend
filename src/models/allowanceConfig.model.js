import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const TABLE = "VAGR_Allowance_Config";

export const AllowanceConfig = {
  async get() {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: "CONFIG",
          SK: "ALLOWANCE"
        }
      })
    );

    return res.Item;
  },

  async update(data) {
    return ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: {
          PK: "CONFIG",
          SK: "ALLOWANCE"
        },
        UpdateExpression: `
          SET managerLoadmanBata = :mlb,
              driverNightAllowance = :dna,
              driverMorningBata = :dmb,
              managerLoadmanCheckin = :mlc,
              driverCheckinNormal = :dcn,
              driverCheckinAfterNightDuty = :dcand,
              updatedAt = :u
        `,
        ExpressionAttributeValues: {
          ":mlb": data.managerLoadmanBata,
          ":dna": data.driverNightAllowance,
          ":dmb": data.driverMorningBata,
          ":mlc": data.managerLoadmanCheckin,
          ":dcn": data.driverCheckinNormal,
          ":dcand": data.driverCheckinAfterNightDuty,
          ":u": new Date().toISOString()
        }
      })
    );
  }
};
