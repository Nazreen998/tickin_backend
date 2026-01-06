import { ddb } from "../../config/dynamo.js";
import { GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

// ✅ helper normalize
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

  // ✅ If looks like orderId (ORDxxxx)
  if (key.startsWith("ORD")) return [key];

  // ✅ else treat as mergeKey
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: "mergeKey = :mk",
      ExpressionAttributeValues: {
        ":mk": key,
      },
    })
  );

  const items = scanRes.Items || [];
  const ids = items.map((x) => x.orderId).filter(Boolean);
  return [...new Set(ids)];
}

/* ============================================================
   ✅ 1) Vehicle Selected (mergeKey supported)
   endpoint: /vehicle-selected/:flowKey
============================================================ */
export const vehicleSelected = async (req, res) => {
  try {
    const { orderId } = req.params; // keep param name (flowKey)
    const flowKey = orderId;

    const { vehicleType } = req.body;
    const user = req.user;

    if (!vehicleType)
      return res
        .status(400)
        .json({ ok: false, message: "vehicleType required" });

    const orderIds = await resolveOrderIdsFromFlowKey(flowKey);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    for (const oid of orderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
          UpdateExpression: "SET vehicleType = :v, vehicleSelectedAt = :t",
          ExpressionAttributeValues: {
            ":v": String(vehicleType).toUpperCase(),
            ":t": new Date().toISOString(),
          },
        })
      );

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
   body: { flowKey }
============================================================ */
export const loadingStart = async (req, res) => {
  try {
    const { orderId, mergeKey, flowKey } = req.body;
    const user = req.user;

    const key = flowKey || mergeKey || orderId;
    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    for (const oid of orderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
          UpdateExpression: `
            SET 
              #s = :st,
              loadingStarted = :ls,
              loadingStartedAt = :t
          `,
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "LOADING_STARTED",
            ":ls": true,
            ":t": new Date().toISOString(),
          },
        })
      );

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
   body: { flowKey }
============================================================ */
export const loadingEnd = async (req, res) => {
  try {
    const { orderId, mergeKey, flowKey } = req.body;
    const user = req.user;

    const key = flowKey || mergeKey || orderId;
    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    for (const oid of orderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
          UpdateExpression: "SET #s = :st, loadingEndAt = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "LOADING_COMPLETED",
            ":t": new Date().toISOString(),
          },
        })
      );

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
   body: { flowKey, driverId, vehicleNo }
============================================================ */
export const assignDriverToOrder = async (req, res) => {
  try {
    const { orderId, mergeKey, flowKey, driverId, vehicleNo } = req.body;
    const user = req.user;

    const key = flowKey || mergeKey || orderId;

    if (!key || !driverId) {
      return res
        .status(400)
        .json({ ok: false, message: "flowKey + driverId required" });
    }

    const driverPk = normalizeUserPk(driverId);

    // ✅ validate driver exists
    const driverRes = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );

    if (
      !driverRes.Item ||
      String(driverRes.Item.role || "").toUpperCase() !== "DRIVER"
    ) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid driverId (not a DRIVER)" });
    }

    const driver = driverRes.Item;

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    for (const oid of orderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
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
        })
      );

      await addTimelineEvent({
        orderId: oid,
        event: "DRIVER_ASSIGNED",
        by: user.mobile,
        data: {
          driverId: driverPk,
          driverName: driver.name,
          driverMobile: driver.mobile,
          vehicleNo: vehicleNo || null,
          flowKey: key,
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
