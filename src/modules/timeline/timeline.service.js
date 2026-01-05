import dayjs from "dayjs";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";

/**
 * ✅ Timeline UI Steps (Amazon style)
 */
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

/**
 * ✅ Alias mapping (important)
 */
const EVENT_ALIASES = {
  ORDER_PLACED_PENDING: "ORDER_CREATED",
  ORDER_CONFIRMED: "ORDER_CREATED",

  SLOT_BOOKED_PARTIAL: "SLOT_BOOKED",
  SLOT_BOOKED_FULL: "SLOT_BOOKED",
  SLOT_BOOKED_CONFIRMED: "SLOT_BOOKED",
};

/**
 * ✅ Build progress (Amazon UI)
 */
function buildProgress({ timelineItems = [], orderCreatedAt = null }) {
  const firstTimeByEvent = {};

  for (const it of timelineItems) {
    const rawEv = String(it.event || "").toUpperCase();
    const mappedEv = EVENT_ALIASES[rawEv] || rawEv;

    if (!firstTimeByEvent[mappedEv]) {
      firstTimeByEvent[mappedEv] = it.timestamp || null;
    }
  }

  if (!firstTimeByEvent["ORDER_CREATED"] && orderCreatedAt) {
    firstTimeByEvent["ORDER_CREATED"] = orderCreatedAt;
  }

  let currentStatus = null;
  for (let i = TIMELINE_STEPS.length - 1; i >= 0; i--) {
    const step = TIMELINE_STEPS[i];
    if (firstTimeByEvent[step]) {
      currentStatus = step;
      break;
    }
  }

  const progress = TIMELINE_STEPS.map((step) => {
    const ts = firstTimeByEvent[step] || null;
    return {
      step,
      label: step.replaceAll("_", " "),
      timestamp: ts,
      displayTime: ts ? dayjs(ts).format("DD MMM YYYY, hh:mm A") : null,
      done: Boolean(ts),
    };
  });

  return { currentStatus, progress };
}

/**
 * ✅ Resolve Final Timeline OrderId
 * - if this order merged into FULL order, show FULL timeline
 */
async function resolveFinalOrderId(orderId) {
  const orderRes = await ddb.send(
    new GetCommand({
      TableName: "tickin_orders",
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
    })
  );

  if (!orderRes.Item) return { finalOrderId: null, order: null };

  const order = orderRes.Item;

  // ✅ if merged, redirect timeline to FULL orderId
  const mergedInto = order.mergedIntoOrderId || null;

  if (mergedInto) {
    return { finalOrderId: mergedInto, order };
  }

  return { finalOrderId: orderId, order };
}

/**
 * ✅ GET Timeline API
 */
export const getOrderTimeline = async (req, res) => {
  try {
    const { orderId } = req.params;

    const role = req.user?.role;
    const mobile = req.user?.mobile;

    if (!role || !mobile) {
      return res.status(401).json({ ok: false, message: "Invalid token" });
    }

    // ✅ Resolve final orderId for timeline
    const { finalOrderId, order } = await resolveFinalOrderId(orderId);

    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    // ✅ Ownership checks use original order meta
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

    // ✅ Fetch timeline using FINAL orderId
    const result = await ddb.send(
      new QueryCommand({
        TableName: "tickin_timeline",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ORDER#${finalOrderId}` },
        ScanIndexForward: true,
      })
    );

    const timeline = result.Items || [];

    const { currentStatus, progress } = buildProgress({
      timelineItems: timeline,
      orderCreatedAt: order.createdAt || order.timestamp || null,
    });

    const orderItems = order.items || [];

    return res.json({
      ok: true,
      message: "Timeline fetched ✅",
      orderId: finalOrderId,              // ✅ show full orderId here
      requestedOrderId: orderId,          // ✅ for reference
      role,
      currentStatus,
      progress,
      count: timeline.length,
      orderMeta: {
        orderId: finalOrderId,
        distributorId: order.distributorId,
        distributorName: order.distributorName,
        status: order.status,
        vehicleNo: order.vehicleNo || null,
        driverId: order.driverId || null,
        totalAmount: order.totalAmount || order.amount || 0,
        createdBy: order.createdBy,
        createdAt: order.createdAt || null,
        mergedIntoOrderId: order.mergedIntoOrderId || null,
      },
      orderItems,
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
