import { ddb } from "../../config/dynamo.js";
import {
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

function normalizeUserPk(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  return s.startsWith("USER#") ? s : `USER#${s}`;
}

/* ============================================================
   ✅ RESOLVER: flowKey -> orderIds
   flowKey = mergeKey OR orderId
============================================================ */
async function resolveOrderIdsFromFlowKey(flowKey) {
  const key = String(flowKey || "").trim();
  if (!key) return [];

  // ✅ orderId case
  if (key.startsWith("ORD")) return [key];

  // ✅ mergeKey case
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: "mergeKey = :mk",
      ExpressionAttributeValues: { ":mk": key },
    })
  );

  const items = scanRes.Items || [];
  const ids = items.map((x) => x.orderId).filter(Boolean);
  return [...new Set(ids)];
}

/* ============================================================
   ✅ COMMON: Update multiple orders helper
============================================================ */
async function updateOrders(orderIds, updatePayload) {
  for (const oid of orderIds) {
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${oid}`, sk: "META" },
        ...updatePayload,
      })
    );
  }
}

/* ============================================================
   ✅ 1) Vehicle Selected (mergeKey supported)
============================================================ */
export const vehicleSelected = async (req, res) => {
  try {
    const flowKey = req.params.orderId;
    const { vehicleType } = req.body;
    const user = req.user;

    if (!vehicleType)
      return res.status(400).json({ ok: false, message: "vehicleType required" });

    const orderIds = await resolveOrderIdsFromFlowKey(flowKey);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    await updateOrders(orderIds, {
      UpdateExpression: "SET vehicleType = :v, vehicleSelectedAt = :t",
      ExpressionAttributeValues: {
        ":v": String(vehicleType).toUpperCase(),
        ":t": new Date().toISOString(),
      },
    });

    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "VEHICLE_SELECTED",
        by: user.mobile,
        extra: { vehicleType, flowKey },
      });
    }

    return res.json({
      ok: true,
      message: "✅ Vehicle selected",
      flowKey,
      affectedOrders: orderIds,
      vehicleType,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ 2) Loading Start (mergeKey supported)
============================================================ */
export const loadingStart = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    await updateOrders(orderIds, {
      UpdateExpression: `
        SET #s = :st,
            loadingStarted = :ls,
            loadingStartedAt = :t
      `,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "LOADING_STARTED",
        ":ls": true,
        ":t": new Date().toISOString(),
      },
    });

    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "LOADING_STARTED",
        by: user.mobile,
        extra: { role: user.role, flowKey: key },
      });
    }

    return res.json({
      ok: true,
      message: "✅ Loading started",
      flowKey: key,
      affectedOrders: orderIds,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ 3) Loading End (mergeKey supported)
============================================================ */
export const loadingEnd = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    await updateOrders(orderIds, {
      UpdateExpression: "SET #s = :st, loadingEndAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "LOADING_COMPLETED",
        ":t": new Date().toISOString(),
      },
    });

    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "LOADING_COMPLETED",
        by: user.mobile,
        extra: { role: user.role, flowKey: key },
      });
    }

    return res.json({
      ok: true,
      message: "✅ Loading completed",
      flowKey: key,
      affectedOrders: orderIds,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ 4) Assign Driver (mergeKey supported)
============================================================ */
export const assignDriverToOrder = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;
    const user = req.user;

    if (!key || !driverId) {
      return res.status(400).json({ ok: false, message: "flowKey + driverId required" });
    }

    const driverPk = normalizeUserPk(driverId);

    const driverRes = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );

    if (!driverRes.Item || String(driverRes.Item.role || "").toUpperCase() !== "DRIVER") {
      return res.status(400).json({ ok: false, message: "Invalid driverId (not a DRIVER)" });
    }

    const driver = driverRes.Item;

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    await updateOrders(orderIds, {
      UpdateExpression:
        "SET #s = :st, driverId = :d, driverName = :n, driverMobile = :m, vehicleNo = :v, driverAssignedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "DRIVER_ASSIGNED",
        ":d": driverPk,
        ":n": driver.name || null,
        ":m": driver.mobile || null,
        ":v": vehicleNo || null,
        ":t": new Date().toISOString(),
      },
    });

    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "DRIVER_ASSIGNED",
        by: user.mobile,
        extra: {
          flowKey: key,
          driverId: driverPk,
          driverName: driver.name,
          driverMobile: driver.mobile,
          vehicleNo: vehicleNo || null,
        },
      });
    }

    return res.json({
      ok: true,
      message: "✅ Driver assigned",
      flowKey: key,
      affectedOrders: orderIds,
      driver: {
        driverId: driverPk,
        name: driver.name,
        mobile: driver.mobile,
        vehicleNo: vehicleNo || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
