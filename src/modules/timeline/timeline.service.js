import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

export const getOrderTimeline = async (req, res) => {
  try {
    const { orderId } = req.params;

    // ✅ JWT values
    const role = req.user?.role;
    const mobile = req.user?.mobile;
    const companyId = req.user?.companyId;

    if (!role || !mobile) {
      return res.status(401).json({ ok: false, message: "Invalid token" });
    }

    // ✅ Step 1: Read order META
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

    // ✅ Step 2: Ownership rules (STRICT)

    // ✅ SALES OFFICER: Only his created orders
    if (role === "SALES OFFICER") {
      if (String(order.createdBy) !== String(mobile)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your order timeline" });
      }
    }

    // ✅ DISTRIBUTOR: Only his distributor orders
    if (role === "DISTRIBUTOR") {
      const tokenDistributorId = req.user?.distributorId;

      if (!tokenDistributorId) {
        return res.status(403).json({
          ok: false,
          message:
            "DistributorId missing in token. Add distributorId in login JWT.",
        });
      }

      if (String(order.distributorId) !== String(tokenDistributorId)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your distributor order timeline" });
      }
    }

    // ✅ DRIVER: Allow ONLY if assigned to him
    if (role === "DRIVER") {
      const assignedDriverId = order.driverId || order.driverMobile || null;

      // order table la driverId save pannala na timeline show panna mudiyathu
      if (!assignedDriverId) {
        return res.status(403).json({
          ok: false,
          message:
            "Driver not assigned yet. Manager must assign driver (driverId not found in order).",
        });
      }

      // driver token la mobile irukkum. compare with order.driverId
      if (String(assignedDriverId) !== String(mobile)) {
        return res.status(403).json({
          ok: false,
          message: "This order is not assigned to you",
        });
      }
    }

    // ✅ MASTER / MANAGER: No restriction (can view all)
    // (You can optionally check companyId match here if needed)

    // ✅ Step 3: Fetch timeline events
    const result = await ddb.send(
      new QueryCommand({
        TableName: "tickin_timeline",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `ORDER#${orderId}`,
        },
        ScanIndexForward: true, // chronological
      })
    );

    const timeline = result.Items || [];

    // ✅ Step 4: Attach order items (for loading items one-by-one UI)
    // Your order items already stored in tickin_orders META
    const orderItems = order.items || [];

    return res.json({
      ok: true,
      message: "Timeline fetched ✅",
      orderId,
      role,
      count: timeline.length,
      orderMeta: {
        orderId: order.orderId || orderId,
        distributorId: order.distributorId,
        distributorName: order.distributorName,
        status: order.status,
        vehicleNo: order.vehicleNo || null,
        driverId: order.driverId || null,
        totalAmount: order.totalAmount || order.amount || 0,
        createdBy: order.createdBy,
        createdAt: order.createdAt || order.timestamp || null,
      },
      orderItems, // ✅ front end can show items one-by-one
      timeline,
    });
  } catch (err) {
    console.error("getOrderTimeline error:", err);
    return res.status(500).json({
      ok: false,
      message: "Error",
      error: err.message,
    });
  }
};
