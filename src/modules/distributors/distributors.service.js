import { ddb } from "../../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "tickin_distributor";

export async function getDistributorByCode(code) {
  if (!code) throw new Error("distributor code required");

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: "DISTRIBUTOR", sk: code },
    })
  );

  if (!res.Item) throw new Error("Distributor not found");

  return res.Item;
}
