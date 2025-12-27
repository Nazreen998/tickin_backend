import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

export const getOrderTimeline = async (req, res) => {
  try {
    const { orderId } = req.params;

    // ✅ JWT values
    const role = req.user?.role;
    const mobile = req.user?.mobile;  // login token has mobile
    const companyId = req.user?.companyId;

    if (!role || !mobile) {
      return res.status(401).json({ ok: false, message: "Invalid token" });
    }

    // ✅ Step 1: Read order META (for ownership check)
    const orderRes = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: {
          pk: `ORDER#${orderId}`,
          sk: "META",
        },
      })
    );

    if (!orderRes.Item) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    const order = orderRes.Item;

    // ✅ Step 2: Ownership rules
    if (role === "SALES OFFICER") {
      // Sales officer can view ONLY his created orders
      if (String(order.createdBy) !== String(mobile)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your order timeline" });
      }
    }

    if (role === "DISTRIBUTOR") {
      // Distributor can view only their orders
      // token must contain distributorId (later we add in JWT)
      const tokenDistributorId = req.user?.distributorId;

      if (!tokenDistributorId) {
        return res.status(403).json({
          ok: false,
          message: "DistributorId missing in token. Add distributorId in login JWT.",
        });
      }

      if (String(order.distributorId) !== String(tokenDistributorId)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your distributor order timeline" });
      }
    }

    // ✅ Master / Manager can view all (no restriction)
    if (role === "DRIVER") {
      return res.status(403).json({
        ok: false,
        message: "Driver timeline not allowed now",
      });
    }

    // ✅ Step 3: Fetch timeline
    const result = await ddb.send(
      new QueryCommand({
        TableName: "tickin_timeline",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `ORDER#${orderId}`,
        },
        ScanIndexForward: true,
      })
    );

    return res.json({
      ok: true,
      message: "Timeline fetched ✅",
      orderId,
      count: result.Items?.length || 0,
      timeline: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Error", error: err.message });
  }
};
