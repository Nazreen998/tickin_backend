import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
export const assignCompany = async (req, res) => {
  try {
    const { mobile, companyId } = req.body;

    if (!mobile || !companyId) {
      return res.status(400).json({
        message: "mobile and companyId required",
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_users",
        Key: {
          pk: `USER#${mobile}`,
          sk: "PROFILE",
        },
        UpdateExpression: "SET companyId = :c",
        ExpressionAttributeValues: {
          ":c": companyId,
        },
      })
    );

    res.json({
      message: "Company assigned successfully",
      mobile,
      companyId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
