import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import jwt from "jsonwebtoken";

export const login = async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res.status(400).json({ message: "Mobile and password required" });
    }

    const userRes = await ddb.send(
      new GetCommand({
        TableName: "tickin_users",
        Key: {
          pk: `USER#${mobile}`,
          sk: "PROFILE",
        },
      })
    );

    if (!userRes.Item) {
      return res.status(401).json({ message: "User not found" });
    }

    const user = userRes.Item;

    if (user.active !== true) {
      return res.status(403).json({ message: "User inactive" });
    }

    if (user.password !== password) {
      return res.status(401).json({ message: "Wrong password" });
    }

    if (!user.companyId) {
      return res.status(403).json({ message: "Company not assigned" });
    }

    const companyRes = await ddb.send(
      new GetCommand({
        TableName: "tickin_company",
        Key: {
          PK: user.companyId,
          SK: "CONFIG",
        },
      })
    );

    if (!companyRes.Item || companyRes.Item.appEnabled !== true) {
      return res.status(403).json({ message: "App blocked by company admin" });
    }

    // ✅ JWT Token (added distributorId)
    // ✅ JWT Token
const token = jwt.sign(
  {
    pk: user.pk,
    mobile: user.mobile,
    role: user.role,
    companyId: user.companyId,
    distributorId: user.distributorId || null,
    location: user.location || null,   // ✅ ADD THIS
  },
  process.env.JWT_SECRET,
  { expiresIn: "7d" }
);

return res.json({
  message: "Login success",
  token,
  user: {
    name: user.name,
    role: user.role,
    mobile: user.mobile,
    companyId: user.companyId,
    distributorId: user.distributorId || null,
    location: user.location || null,   // ✅ ADD THIS
    companyName: companyRes.Item.companyName,
  },
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
