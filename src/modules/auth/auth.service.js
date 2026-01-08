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

    // ✅ Role-based distributor mapping
    const role = user.role || "UNKNOWN";

    // ✅ always return these fields
    const responseUser = {
      name: user.name || "",
      role,
      mobile: user.mobile || mobile,
      companyId: user.companyId,
      companyName: companyRes.Item?.companyName || null,
    };

    // ✅ Token payload base
    const payload = {
      pk: user.pk,
      name: user.name || "UNKNOWN",                  // 🔥 ADD THIS
      mobile: user.mobile || mobile,
      role,
      companyId: user.companyId,
    };

    // ✅ Sales Officer → multi distributor list
     if (role === "SALES OFFICER" || role === "SALES OFFICE") {
      const list = parseAllowedCodes(user.allowedDistributorCodes);
      responseUser.allowedDistributorCodes = list;
      payload.allowedDistributorCodes = list;
    }

    // ✅ Salesman/Distributor → single distributorCode
    else if (role === "SALESMAN" || role === "DISTRIBUTOR") {
      const dist =
        user.distributorCode || user.distributorId || user.distributor || null;

      responseUser.distributorCode = dist;
      payload.distributorCode = dist;
    }

    // ✅ Default fallback
    else {
      responseUser.distributorCode =
        user.distributorCode || user.distributorId || null;
      payload.distributorCode =
        user.distributorCode || user.distributorId || null;
    }

    // ✅ JWT Token
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({
      message: "Login success",
      token,
      user: responseUser,
    });
  } 
  catch (err) {
    console.error("LOGIN ERROR =>", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};
function parseAllowedCodes(val) {
  if (Array.isArray(val)) return val;

  if (typeof val === "string") {
    // string like "\"D002\",\"D007\",\"D015\""
    const cleaned = val.replace(/\\/g, "").replace(/"/g, "");
    return cleaned.split(",").map((x) => x.trim()).filter(Boolean);
  }

  return [];
}
