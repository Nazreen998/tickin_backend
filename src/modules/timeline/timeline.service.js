import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

const TIMELINE_STEPS = [
  "ORDER_CREATED",
  "SLOT_BOOKED",
  "LOAD_START",
  "VEHICLE_SELECTED",
  "LOAD_END",
  "DRIVER_ASSIGNED",
  "DRIVER_STARTED",
  "DRIVER_REACHED_DISTRIBUTOR",
  "UNLOAD_START",
  "UNLOAD_END",
  "WAREHOUSE_REACHED",
];

function buildProgress(timelineItems = []) {
  // Map event => first time occurred
  const firstTimeByEvent = {};
  for (const it of timelineItems) {
    const ev = String(it.event || "").toUpperCase();
    if (!firstTimeByEvent[ev]) firstTimeByEvent[ev] = it.timestamp || null;
  }

  // Find last completed step
  let currentStatus = null;
  for (let i = TIMELINE_STEPS.length - 1; i >= 0; i--) {
    const step = TIMELINE_STEPS[i];
    if (firstTimeByEvent[step]) {
      currentStatus = step;
      break;
    }
  }

  const progress = TIMELINE_STEPS.map((step) => ({
    step,
    label: step.replaceAll("_", " "),
    time: firstTimeByEvent[step] || null,
    done: Boolean(firstTimeByEvent[step]),
  }));

  return { currentStatus, progress };
}

export const getOrderTimeline = async (req, res) => {
  try {
    const { orderId } = req.params;

    const role = req.user?.role;
    const mobile = req.user?.mobile;

    if (!role || !mobile) {
      return res.status(401).json({ ok: false, message: "Invalid token" });
    }

    // ✅ 1) Read order META
    const orderRes = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!orderRes.Item) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    const order = orderRes.Item;

    // ✅ 2) Ownership rules (as you wrote) — keep same
    if (role === "SALES OFFICER") {
      if (String(order.createdBy) !== String(mobile)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your order timeline" });
      }
    }

    if (role === "DISTRIBUTOR") {
      const tokenDistributorId = req.user?.distributorId;
      if (!tokenDistributorId) {
        return res.status(403).json({
          ok: false,
          message: "DistributorId missing in token.",
        });
      }
      if (String(order.distributorId) !== String(tokenDistributorId)) {
        return res
          .status(403)
          .json({ ok: false, message: "Not your distributor order timeline" });
      }
    }

    if (role === "DRIVER") {
      const assignedDriverId = order.driverId || order.driverMobile || null;
      if (!assignedDriverId) {
        return res.status(403).json({
          ok: false,
          message: "Driver not assigned yet.",
        });
      }
      if (String(assignedDriverId) !== String(mobile)) {
        return res.status(403).json({
          ok: false,
          message: "This order is not assigned to you",
        });
      }
    }

    // ✅ 3) Fetch timeline events
    const result = await ddb.send(
      new QueryCommand({
        TableName: "tickin_timeline",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ORDER#${orderId}` },
        ScanIndexForward: true,
      })
    );

    const timeline = result.Items || [];

    // ✅ 4) Build Amazon style progress
    const { currentStatus, progress } = buildProgress(timeline);

    const orderItems = order.items || [];

    return res.json({
      ok: true,
      message: "Timeline fetched ✅",
      orderId,
      role,
      currentStatus,            // ✅ current step
      progress,                 // ✅ horizontal line UI use this
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
        createdAt: order.createdAt || null,
      },
      orderItems,
      timeline, // raw events (optional UI debug)
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
