import jwt from "jsonwebtoken";
import { ddb } from "../config/dynamo.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

/**
 * ✅ Load salesman -> distributor mapping from DynamoDB
 * Table: tickin_salesman_distributor_map
 * PK: SALESMAN#<mobile>
 * SK: DISTRIBUTOR
 */
async function attachSalesmanDistributor(decoded) {
  try {
    const role = decoded?.role;

    // ✅ only for Sales Officer / Salesman / Distributor roles
    if (
      role !== "SALES OFFICER" &&
      role !== "SALESMAN" &&
      role !== "DISTRIBUTOR"
    ) {
      return decoded;
    }

    // ✅ If already has distributorCode, no need lookup
    if (decoded?.distributorCode || decoded?.distributorId) {
      // normalize distributorCode if it is in distributorId
      if (!decoded.distributorCode && decoded.distributorId) {
        decoded.distributorCode = decoded.distributorId;
      }

      // if format like "DISTRIBUTOR#D015"
      if (
        typeof decoded.distributorCode === "string" &&
        decoded.distributorCode.includes("#")
      ) {
        decoded.distributorCode = decoded.distributorCode.split("#").pop();
      }

      return decoded;
    }

    const mobile = decoded?.mobile;
    if (!mobile) return decoded; // cannot lookup without mobile

    const res = await ddb.send(
      new GetCommand({
        TableName: "tickin_salesman_distributor_map",
        Key: {
          pk: `SALESMAN#${mobile}`,
          sk: "DISTRIBUTOR",
        },
      })
    );

    if (res.Item) {
      decoded.distributorCode = res.Item.distributorCode;
      decoded.location = res.Item.location ?? decoded.location ?? null;
    }

    return decoded;
  } catch (e) {
    // ✅ Don't block auth if mapping missing
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

    // ✅ attach distributorCode for Sales Officer if missing
    decoded = await attachSalesmanDistributor(decoded);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ✅ alias
export const requireAuth = verifyToken;
