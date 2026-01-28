// orders.flow.service.js
import { ddb } from "../../config/dynamo.js";
import { GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE || "tickin_slot_bookings";

function normalizeUserPk(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  return s.startsWith("USER#") ? s : `USER#${s}`;
}

// ✅ Normalize orderId consistently (prevents duplicates like "123" vs "ORD123")
function normalizeOrderId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (s.startsWith("ORDER#")) return s.replace("ORDER#", "");
  if (s.startsWith("ORD")) return s;
  // if only digits, still prefix ORD
  if (/^\d+$/.test(s)) return `ORD${s}`;
  // otherwise keep as-is (safety)
  return s;
}
/* ============================================================
   ✅ RESOLVER: flowKey -> orderIds
   flowKey = mergeKey OR orderId
============================================================ */
async function resolveOrderIdsFromFlowKey(flowKey) {
  const key = String(flowKey || "").trim();
  if (!key) return [];

  // ✅ SPECIAL: If ORD_FULL_* flowKey => expand to child orders
  if (key.startsWith("ORD_FULL_")) {
    const fullMeta = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${key}`, sk: "META" },
      })
    );

    const merged = Array.isArray(fullMeta?.Item?.mergedOrderIds)
      ? fullMeta.Item.mergedOrderIds
      : [];

    const all = [key, ...merged].map(normalizeOrderId).filter(Boolean);

    // unique
    return [...new Set(all)];
  }

  // ✅ orderId direct (normal orders)
  if (key.startsWith("ORD")) return [key];
  if (/^\d+$/.test(key)) return [`ORD${key}`];

  // ✅ 1) Try BOOKINGS table (GEO_* flows)
  const bRes = await ddb.send(
    new ScanCommand({
      TableName: BOOKINGS_TABLE,
      FilterExpression: "mergeKey = :m OR flowKey = :m",
      ExpressionAttributeValues: { ":m": key },
      ProjectionExpression: "orderId, mergeKey, flowKey, mergedIntoOrderId",
    })
  );

  const bIds = (bRes.Items || [])
    .map((x) => normalizeOrderId(x.orderId))
    .filter(Boolean);

  // ✅ 2) Also scan ORDERS table by mergeKey (may include ORD_FULL_ meta)
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: "mergeKey = :m",
      ExpressionAttributeValues: { ":m": key },
      ProjectionExpression: "orderId, pk, mergeKey, mergedIntoOrderId",
    })
  );

  const ids = (scanRes.Items || [])
    .map((x) =>
      normalizeOrderId(x.orderId || (x.pk ? x.pk.replace("ORDER#", "") : null))
    )
    .filter(Boolean);

  const all = [...bIds, ...ids].filter(Boolean);
  const uniq = [...new Set(all)];

  // keep FULL order first (optional)
  uniq.sort((a, b) => {
    const af = String(a).startsWith("ORD_FULL_") ? 0 : 1;
    const bf = String(b).startsWith("ORD_FULL_") ? 0 : 1;
    return af - bf;
  });

  return uniq;
}

/* ============================================================
   ✅ Helper: Update multiple orders safely
============================================================ */
async function updateOrders(orderIds, updatePayload) {
  for (const raw of orderIds) {
    const oid = normalizeOrderId(raw);
    if (!oid) continue;

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
  for (const raw of orderIds) {
    const oid = normalizeOrderId(raw);
    if (!oid) return false;

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
    if (!key) {
      return res.status(400).json({ ok: false, message: "flowKey required" });
    }

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0) {
      return res
        .status(404)
        .json({ ok: false, message: "No orders found for this flowKey" });
    }

    // fetch all orders meta
    const orders = [];
    for (const raw of orderIds) {
      const oid = normalizeOrderId(raw);
      if (!oid) continue;

      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
        })
      );
      if (g.Item) orders.push(g.Item);
    }

    if (orders.length === 0) {
      return res
        .status(404)
        .json({ ok: false, message: "Orders meta not found" });
    }

    // ✅ decide master order id for tracking (can use ORD_FULL_)
    const masterFromFull = orders.find((o) =>
      String(o.orderId || "").startsWith("ORD_FULL_")
    )?.orderId;

    const masterFromChildren =
      orders
        .map((o) => o.mergedIntoOrderId)
        .find((x) => x && String(x).trim() !== "") || null;

    const masterOrderId =
      masterFromFull || masterFromChildren || orders[0]?.orderId || orderIds[0];

    // ✅ IMPORTANT FIX:
    // Don't include ORD_FULL_ in totals/items/distributors (it may have empty/combined data)
    const childOrders = orders.filter(
      (o) => !String(o.orderId || "").startsWith("ORD_FULL_")
    );

    // If for some reason only FULL exists, fallback to all orders
    const calcOrders = childOrders.length > 0 ? childOrders : orders;

    // ✅ Combined response for UI
    let totalQty = 0;
    let grandTotal = 0;
    const loadingItems = [];

    calcOrders.forEach((o) => {
      totalQty += Number(o.totalQty || o.qty || 0);
      grandTotal += Number(o.totalAmount || o.grandTotal || o.total || 0);

      // ✅ prefer items first (your UI expects items even before loading starts)
      const items = o.items || o.loadingItems || [];
      items.forEach((it) => loadingItems.push(it));
    });

    // ✅ status: prefer most advanced among calcOrders
    let status = "UNKNOWN";
    const priority = [
      "CONFIRMED",
      "SLOT_BOOKED",
      "VEHICLE_SELECTED",
      "LOADING_STARTED",
      "LOADING_COMPLETED",
      "DRIVER_ASSIGNED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ];
    const stList = calcOrders.map((o) => String(o.status || "").toUpperCase());
    // pick the highest priority match (last in priority)
    for (const p of priority) {
      if (stList.includes(p)) status = p;
    }
    if (status === "UNKNOWN") status = calcOrders[0]?.status || "UNKNOWN";

    const distributors = calcOrders.map((o, idx) => ({
      label: `D${idx + 1}`,
      distributorId: o.distributorId || null,
      distributorName: o.distributorName || null,
      orderId: o.orderId || null,
      amount: Number(o.totalAmount || o.grandTotal || o.total || 0),
      qty: Number(o.totalQty || o.qty || 0),
    }));
    // ✅ FIX: For GEO/slot flows, compute amount from BOOKINGS table (prevents double)
let fixedGrandTotal = grandTotal;

const looksLikeGeo = String(key || "").startsWith("GEO_") || String(key || "").includes("GEO_");

if (looksLikeGeo) {
  const bRes = await ddb.send(
    new ScanCommand({
      TableName: BOOKINGS_TABLE,
      FilterExpression: "mergeKey = :m OR flowKey = :m",
      ExpressionAttributeValues: { ":m": key },
      ProjectionExpression: "orderId, amount",
    })
  );

  // dedupe by orderId
  const seen = new Set();
  let sum = 0;
  for (const b of (bRes.Items || [])) {
    const oid = normalizeOrderId(b.orderId);
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    sum += Number(b.amount || 0);
  }

  if (sum > 0) fixedGrandTotal = sum;
}


    const distributorDisplay =
      distributors.length <= 1
        ? (distributors[0]?.distributorName || "-")
        : distributors
            .map((d) => `${d.label}: ${d.distributorName || "-"}`)
            .join(" | ");

    return res.json({
      ok: true,
      flowKey: key,
      mergeKey: orders[0]?.mergeKey || null,

      // ✅ tracking/master
      masterOrderId,
      trackingOrderId: masterOrderId,

      orderIds: calcOrders.map((o) => o.orderId).filter(Boolean),
      totalQty,
      grandTotal: fixedGrandTotal,
      status,
      vehicleType: calcOrders[0]?.vehicleType || null,
      vehicleNo: calcOrders[0]?.vehicleNo || null,
      loadingItems,
      distributors,       // ✅ structured
      distributorDisplay, // ✅ string for UI
      orders: calcOrders, // ✅ full orders (child orders only)
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

    if (!flowKey)
      return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!vehicleType && !vehicleNo)
      return res
        .status(400)
        .json({ ok: false, message: "vehicleType or vehicleNo required" });

    const orderIds = await resolveOrderIdsFromFlowKey(flowKey);
    if (orderIds.length === 0)
      return res.status(404).json({ ok: false, message: "No orders found" });

    + await updateOrders(orderIds, {
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
============================================================ */
export const loadingStart = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = req.body.orderId
      ? [req.body.orderId]
      : await resolveOrderIdsFromFlowKey(key);

    if (orderIds.length === 0)
      return res
        .status(404)
        .json({ ok: false, message: "No orders found for this key" });

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

    for (const oid of orderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "LOADING_STARTED",
        by: user?.mobile || "system",
        byUserName: user?.name || user?.userName || null,
        role: user?.role || "MANAGER",
        data: { flowKey: key },
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
============================================================ */
export const loadingEnd = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });

    const orderIds = req.body.orderId
      ? [req.body.orderId]
      : await resolveOrderIdsFromFlowKey(key);

    if (orderIds.length === 0)
      return res
        .status(404)
        .json({ ok: false, message: "No orders found for this key" });

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
   ✅ ASSIGN DRIVER  (UPDATED - FULL ORDER update + timeline event + fixed vars)
   - Updates child orders + ORD_FULL_ (if exists)
   - Adds timeline event for FULL order (so tracking screen shows DRIVER_ASSIGNED)
   - Fixes: finalorderIds typo, ensureVehicleSelected uses finalOrderIds
============================================================ */
export const assignDriver = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!driverId)
      return res.status(400).json({ ok: false, message: "driverId required" });

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (orderIds.length === 0)
      return res
        .status(404)
        .json({ ok: false, message: "No orders found for this key" });

    // ✅ Vehicle must be selected (only child orders check)
    const vehicleOk = await ensureVehicleSelected(orderIds);
    if (!vehicleOk) {
      return res.status(400).json({
        ok: false,
        message: "❌ Vehicle not selected. Select vehicle first.",
      });
    }

    // ✅ Find FULL order id (ORD_FULL_) if any
    let fullOrderId = orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

    if (!fullOrderId) {
      // try from child meta mergedIntoOrderId
      for (const raw of orderIds) {
        const oid = normalizeOrderId(raw);
        if (!oid) continue;

        const g = await ddb.send(
          new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { pk: `ORDER#${oid}`, sk: "META" },
          })
        );

        if (g.Item?.mergedIntoOrderId) {
          fullOrderId = normalizeOrderId(g.Item.mergedIntoOrderId);
          break;
        }
      }
    }

    // ✅ FINAL list = child orders + FULL order (if exists)
    const finalOrderIds = fullOrderId
      ? [...new Set([...orderIds.map(normalizeOrderId), fullOrderId].filter(Boolean))]
      : [...new Set(orderIds.map(normalizeOrderId).filter(Boolean))];

    // ✅ driver lookup
    const driverPk = normalizeUserPk(driverId);

    const dg = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );

    const driver = dg.Item;
    if (!driver) {
      return res.status(404).json({ ok: false, message: "Driver not found" });
    }

    const driverName = driver.name || driver.userName || "Driver";
    const driverMobile = driver.mobile || null;

    // ✅ Update ALL (child + FULL)
    await updateOrders(finalOrderIds, {
      UpdateExpression:
        "SET #s = :st, driverId = :d, driverName = :dn, driverMobile = :dm, vehicleNo = :vn",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "DRIVER_ASSIGNED",
        ":d": driverPk,
        ":dn": driverName,
        ":dm": driverMobile,
        ":vn": vehicleNo || null,
      },
    });

    // ✅ Add timeline event for ALL (important for tracking FULL order timeline)
    const user = req.user || {};
    for (const oid of finalOrderIds) {
      await addTimelineEvent({
        orderId: oid,
        event: "DRIVER_ASSIGNED",
        by: user?.mobile || "system",
        byUserName: user?.name || user?.userName || null,
        role: user?.role || "MANAGER",
        data: {
          flowKey: key,
          driverId: driverPk,
          driverName,
          driverMobile,
          vehicleNo: vehicleNo || null,
        },
      });
      
    }

    return res.json({
      ok: true,
      message: "✅ Driver assigned",
      flowKey: key,
      affectedOrders: finalOrderIds, // ✅ typo fix (finalorderIds இல்லை)
      driver: {
        driverId: driverPk,
        name: driverName,
        mobile: driverMobile,
        vehicleNo: vehicleNo || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/* ============================================================
   ✅ NEW: List drivers for dropdown (Manager/Master)  (UNCHANGED)
============================================================ */
export const getDriversForDropdown = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "#r = :d",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":d": "DRIVER" },
        ProjectionExpression: "pk, name, userName, mobile, role",
      })
    );

    const drivers = (result.Items || []).map((u) => ({
      driverId: u.pk, // USER#...
      name: u.name || u.userName || "Driver",
      mobile: u.mobile || null,
    }));

    return res.json({ ok: true, count: drivers.length, drivers });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
