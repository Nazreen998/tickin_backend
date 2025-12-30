import jwt from "jsonwebtoken";
import { ddb } from "../config/dynamo.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

async function attachAllowedDistributors(decoded) {
  try {
    const role = decoded?.role;

    const isSales =
      role === "SALES OFFICER" || role === "SALESMAN" || role === "DISTRIBUTOR";

    if (!isSales) return decoded;

    // ✅ get mobile
    let mobile = decoded?.mobile;

    // fallback: pk = USER#8825...
    if (!mobile && decoded?.pk && String(decoded.pk).includes("#")) {
      mobile = String(decoded.pk).split("#").pop();
    }

    if (!mobile) return decoded;

    // ✅ Query all distributors for that salesman
    const pk = `SALESMAN#${String(mobile).trim()}`;

    const res = await ddb.send(
      new QueryCommand({
        TableName: "tickin_salesman_distributor_map",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
      })
    );

    const items = res.Items || [];

    // allowed distributors list
    const allowed = items
      .map((x) => String(x?.distributorCode || "").trim())
      .filter(Boolean);

    if (allowed.length > 0) {
      decoded.allowedDistributors = allowed;

      // ✅ also keep one distributorCode for backward compatibility
      // (first one as default)
      if (!decoded.distributorCode) {
        decoded.distributorCode = allowed[0];
      }
    }

    return decoded;
  } catch (e) {
    // do not block auth
    return decoded;
  }
}

export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Token missing" });
    }

    const token = authHeader.split(" ")[1];
    let decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ attach allowed distributors for Sales Officer/Salesman
    decoded = await attachAllowedDistributors(decoded);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ✅ alias
export const requireAuth = verifyToken;
