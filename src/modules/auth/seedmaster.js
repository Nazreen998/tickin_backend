import bcrypt from "bcrypt";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { v4 as uuid } from "uuid";

const run = async () => {
  const passwordHash = await bcrypt.hash("1234", 10);

  await ddb.send(
    new PutCommand({
      TableName: "tickin_users",
      Item: {
        userId: uuid(),
        username: "master",
        passwordHash,
        role: "MASTER",
        name: "Master Admin",
        active: true,
        createdAt: new Date().toISOString(),
      },
    })
  );

  console.log("MASTER user created");
};

run();
