import jwt from "jsonwebtoken";
import { ddb } from "../config/dynamo.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

function normalizeRole(role) {
  return String(role || "")
    .trim()
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

async function attachAllowedDistributors(decoded) {
  try {
    const role = normalizeRole(decoded?.role);

    const isSales =
      role === "SALES OFFICER" ||
      role === "SALES_OFFICER_VNR" ||
      role === "SALES OFFICER VNR" ||
      role === "SALESMAN" ||
      role === "DISTRIBUTOR" ||
      role === "SALES OFFICE";

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

    const allowed = items
      .map((x) => String(x?.distributorCode || "").trim())
      .filter(Boolean);

    if (allowed.length > 0) {
      decoded.allowedDistributorCodes = allowed; 
      decoded.allowedDistributors = allowed;

      if (!decoded.distributorCode) {
        decoded.distributorCode = allowed[0];
      }
    }

    return decoded;
  } catch (e) {
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

    decoded = await attachAllowedDistributors(decoded);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

export const requireAuth = verifyToken;
