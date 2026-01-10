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

export async function assignDriverToOrder(req, res) {
  return assignDriver(req, res);
}

/* ============================================================
   ✅ RESOLVER: flowKey -> orderIds
   flowKey = mergeKey OR orderId
============================================================ */
async function resolveOrderIdsFromFlowKey(flowKey) {
  const key = String(flowKey || "").trim();
  if (!key) return [];

  // ✅ orderId case (ORDxxxx)
  if (key.startsWith("ORD")) {
    return [key];
  }

  // ✅ orderId without prefix
  if (/^\d+$/.test(key)) {
    return [`ORD${key}`];
  }

  // ✅ mergeKey case
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: "mergeKey = :m",
      ExpressionAttributeValues: {
        ":m": key,
      },
      ProjectionExpression: "orderId, pk, mergeKey",
    })
  );

  const ids = (scanRes.Items || [])
    .map((x) => x.orderId || (x.pk ? x.pk.replace("ORDER#", "") : null))
    .filter(Boolean);

  return [...new Set(ids)];
}

/* ============================================================
   ✅ Helper: Update multiple orders safely
============================================================ */
async function updateOrders(orderIds, updatePayload) {
  for (const oid of orderIds) {
    const tryIds = [
      oid,
      oid.startsWith("ORD") ? oid.replace("ORD", "") : "ORD" + oid,
    ];

    let found = null;

    for (const t of tryIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${t}`, sk: "META" },
        })
      );
      if (g.Item) {
        found = t;
        break;
      }
    }

    if (!found) continue;

    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${found}`, sk: "META" },
        ...updatePayload,
      })
    );
  }
}

/* ============================================================
   ✅ GUARD: Ensure vehicle selected for all orders
============================================================ */
async function ensureVehicleSelected(orderIds) {
  for (const oid of orderIds) {
    const g = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${oid}`, sk: "META" },
      })
    );
    const item = g.Item;
    if (!item || !item.vehicleType) return false;
  }
  return true;
}

/* ============================================================
   ✅ GET FLOW (flowKey = orderId OR mergeKey)
============================================================ */
export const getOrderFlowByKey = async (req, res) => {
  try {
    const key = req.params.flowKey;
    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found for this flowKey" });

    // fetch all orders meta
    const orders = [];
    for (const oid of orderIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
        })
      );
      if (g.Item) orders.push(g.Item);
    }

    // ✅ Combined response for UI
    let totalQty = 0;
    let grandTotal = 0;

    const loadingItems = [];

    orders.forEach((o) => {
      totalQty += Number(o.totalQty || o.qty || 0);
      grandTotal += Number(o.grandTotal || o.total || 0);

      const items = o.loadingItems || o.items || [];
      items.forEach((it) => loadingItems.push(it));
    });

    const status = orders[0]?.status || "UNKNOWN";

    return res.json({
      ok: true,
      flowKey: key,
      mergeKey: orders[0]?.mergeKey || null,
      orderIds,
      totalQty,
      grandTotal,
      status,
      vehicleType: orders[0]?.vehicleType || null,
      vehicleNo: orders[0]?.vehicleNo || null,
      loadingItems,
      orders, // ✅ send full orders for D1/D2 separation if needed
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ VEHICLE SELECTED (Manager selects vehicle)
============================================================ */
export const vehicleSelected = async (req, res) => {
  try {
    const flowKey = req.params.flowKey;
    const { vehicleType, vehicleNo } = req.body;

    if (!flowKey) return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!vehicleType && !vehicleNo)
      return res.status(400).json({ ok: false, message: "vehicleType or vehicleNo required" });

    const orderIds = await resolveOrderIdsFromFlowKey(flowKey);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    await updateOrders(orderIds, {
      UpdateExpression: "SET vehicleType = :v, vehicleNo = :vn",
      ExpressionAttributeValues: {
        ":v": vehicleType || vehicleNo,
        ":vn": vehicleNo || null,
      },
    });

    return res.json({
      ok: true,
      message: "✅ Vehicle selected",
      flowKey,
      affectedOrders: orderIds,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ LOADING START
   ✅ Supports mergeKey + orderId (D1/D2 separate)
   ✅ Requires vehicle selected first
============================================================ */
export const loadingStart = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });

    // ✅ If orderId provided => only that order gets updated
    const orderIds = req.body.orderId
      ? [req.body.orderId]
      : await resolveOrderIdsFromFlowKey(key);

    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found for this key" });

    // ✅ Vehicle must be selected
    const vehicleOk = await ensureVehicleSelected(orderIds);
    if (!vehicleOk) {
      return res.status(400).json({
        ok: false,
        message: "❌ Vehicle not selected. Select vehicle first.",
      });
    }

    await updateOrders(orderIds, {
      UpdateExpression: "SET #s = :st, loadingStarted = :ls, loadingStartedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "LOADING_STARTED",
        ":ls": true,
        ":t": new Date().toISOString(),
      },
    });

    // timeline event per order
    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "LOADING_STARTED",
        by: user?.mobile || "system",
  byUserName: user?.name || user?.userName || null,
  role: user?.role || "MANAGER",
  data: { flowKey: key },  // ✅ use data
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
   ✅ LOADING END
   ✅ Supports mergeKey + orderId (D1/D2 separate)
   ✅ Requires vehicle selected first
============================================================ */
export const loadingEnd = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = req.body.orderId
      ? [req.body.orderId]
      : await resolveOrderIdsFromFlowKey(key);

    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found for this key" });

    // ✅ Vehicle must be selected
    const vehicleOk = await ensureVehicleSelected(orderIds);
    if (!vehicleOk) {
      return res.status(400).json({
        ok: false,
        message: "❌ Vehicle not selected. Select vehicle first.",
      });
    }

    await updateOrders(orderIds, {
      UpdateExpression: "SET #s = :st, loadingEndAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "LOADING_COMPLETED",
        ":t": new Date().toISOString(),
      },
    });

    // timeline per order
    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "LOADING_COMPLETED",
        by: user?.mobile || "system",
  byUserName: user?.name || user?.userName || null,
  role: user?.role || "MANAGER",
  data: { flowKey: key },
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
   ✅ ASSIGN DRIVER
   ✅ Vehicle must be selected first
============================================================ */
export const assignDriver = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;

    if (!key) return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!driverId) return res.status(400).json({ ok: false, message: "driverId required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found for this key" });

    // ✅ Vehicle must be selected before assigning driver
    const vehicleOk = await ensureVehicleSelected(orderIds);
    if (!vehicleOk) {
      return res.status(400).json({
        ok: false,
        message: "❌ Vehicle not selected. Select vehicle first.",
      });
    }

    const driverPk = normalizeUserPk(driverId);

    const dg = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );
    const driver = dg.Item;
    if (!driver)
      return res.status(404).json({ ok: false, message: "Driver not found" });

    await updateOrders(orderIds, {
      UpdateExpression: "SET #s = :st, driverId = :d, driverName = :dn, driverMobile = :dm,vehicleNo = :vn",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "DRIVER_ASSIGNED",
        ":d": driverPk,
        ":dn": driver.name || driver.userName || "Driver",
        ":dm": driver.mobile || null,
        ":vn": vehicleNo || null,
      },
    });

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
