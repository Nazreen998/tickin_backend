// orders.flow.service.js  ✅ FINAL FIXED
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
  if (/^\d+$/.test(s)) return `ORD${s}`;
  return s;
}

/* ============================================================
   ✅ RESOLVER: flowKey -> orderIds
   flowKey = mergeKey OR orderId OR ORD_FULL_
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

  // keep FULL order first
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
   (FULL order might have vehicleNo; child might have vehicleType)
============================================================ */
async function ensureVehicleSelected(orderIds) {
  for (const raw of orderIds) {
    const oid = normalizeOrderId(raw);
    if (!oid || !oid.startsWith("ORD_FULL_")) continue;

    const g = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${oid}`, sk: "META" },
      })
    );

    const item = g.Item;
    if (item?.vehicleNo || item?.vehicleType) {
      return true;
    }
  }
  return false;
}
/* ============================================================
   ✅ GET FLOW (flowKey = orderId OR mergeKey OR ORD_FULL_)
   ✅ FIX: GEO/FULL flows totals + distributors should match BOOKING (no mismatch)
============================================================ */
export const getOrderFlowByKey = async (req, res) => {
  console.log("🔥🔥 FLOW SERVICE HIT", req.params.flowKey);
  try {
    const key = String(req.params.flowKey || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, message: "flowKey required" });
    }

    /* --------------------------------------------------
       1️⃣ Resolve orderIds from ANY key
    -------------------------------------------------- */
    let orderIds = await resolveOrderIdsFromFlowKey(key);

    // 🔥 FORCE include ORD_FULL for direct ORD
    if (orderIds.length === 1) {
      const oid = normalizeOrderId(orderIds[0]);
      if (oid && !oid.startsWith("ORD_FULL_")) {
        const tryFull = `ORD_FULL_${oid.replace(/^ORD/, "")}`;
        orderIds.unshift(tryFull);
      }
    }

    if (orderIds.length === 0) {
      return res
        .status(404)
        .json({ ok: false, message: "No orders found for this flowKey" });
    }

    /* --------------------------------------------------
       2️⃣ 🔥 AUTO-CREATE ORD_FULL META IF MISSING
    -------------------------------------------------- */
    for (const raw of orderIds) {
      const oid = normalizeOrderId(raw);
      if (!oid || !oid.startsWith("ORD_FULL_")) continue;

      const fg = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${oid}`, sk: "META" },
        })
      );

      // ❌ FULL META missing → CREATE from child ORD
      if (!fg.Item) {
        const baseOrd = `ORD${oid.replace("ORD_FULL_", "")}`;

        const child = await ddb.send(
          new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { pk: `ORDER#${baseOrd}`, sk: "META" },
          })
        );

        if (child.Item) {
          await ddb.send(
            new UpdateCommand({
              TableName: ORDERS_TABLE,
              Key: { pk: `ORDER#${oid}`, sk: "META" },
              UpdateExpression: `
                SET orderId = :o,
                    status = :s,
                    mergeKey = :m
              `,
              ExpressionAttributeValues: {
                ":o": oid,
                ":s": child.Item.status || "CONFIRMED",
                ":m": child.Item.mergeKey || null,
              },
            })
          );
        }
      }
    }

    /* --------------------------------------------------
       3️⃣ Fetch all order META
    -------------------------------------------------- */
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

    /* --------------------------------------------------
       4️⃣ Decide MASTER / TRACKING order
    -------------------------------------------------- */
    const masterFromFull = orders.find((o) =>
      String(o.orderId || "").startsWith("ORD_FULL_")
    )?.orderId;

    const masterFromChildren =
      orders
        .map((o) => o.mergedIntoOrderId)
        .find((x) => x && String(x).trim() !== "") || null;

    const masterOrderId =
      masterFromFull ||
      masterFromChildren ||
      orders[0]?.orderId ||
      orderIds[0];

    /* --------------------------------------------------
       5️⃣ Calc orders (exclude FULL)
    -------------------------------------------------- */
    const childOrders = orders.filter(
      (o) => !String(o.orderId || "").startsWith("ORD_FULL_")
    );
    const calcOrders = childOrders.length > 0 ? childOrders : orders;

    /* --------------------------------------------------
       6️⃣ Totals + Items
    -------------------------------------------------- */
    let totalQty = 0;
    let grandTotal = 0;
    const loadingItems = [];

    calcOrders.forEach((o) => {
      totalQty += Number(o.totalQty || o.qty || 0);
      grandTotal += Number(o.totalAmount || o.grandTotal || o.total || 0);

      const items = o.items || o.loadingItems || [];
      items.forEach((it) => loadingItems.push(it));
    });

    /* --------------------------------------------------
       7️⃣ Status priority
    -------------------------------------------------- */
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
    for (const p of priority) {
      if (stList.includes(p)) status = p;
    }
    if (status === "UNKNOWN") status = calcOrders[0]?.status || "UNKNOWN";

    /* --------------------------------------------------
       8️⃣ Distributors
    -------------------------------------------------- */
    const distributors = calcOrders.map((o, idx) => ({
      label: `D${idx + 1}`,
      distributorId: o.distributorId || null,
      distributorName: o.distributorName || null,
      orderId: o.orderId || null,
      amount: Number(o.totalAmount || o.grandTotal || o.total || 0),
      qty: Number(o.totalQty || o.qty || 0),
    }));

    const distributorDisplay =
      distributors.length <= 1
        ? distributors[0]?.distributorName || "-"
        : distributors
            .map((d) => `${d.label}: ${d.distributorName || "-"}`)
            .join(" | ");

    /* --------------------------------------------------
       9️⃣ RESPONSE
    -------------------------------------------------- */
    return res.json({
      ok: true,
      mergeKey: orders[0]?.mergeKey || null,
      flowKey: masterOrderId,
      masterOrderId,
      trackingOrderId: masterOrderId,
      orderIds: calcOrders.map((o) => o.orderId).filter(Boolean),
      totalQty,
      grandTotal,
      status,
      vehicleType: calcOrders[0]?.vehicleType || null,
      vehicleNo: calcOrders[0]?.vehicleNo || null,
      loadingItems,
      distributors,
      distributorDisplay,
      orders: calcOrders,
    });
  } catch (err) {
    console.error("getOrderFlowByKey error", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
};
/* ============================================================
   ✅ VEHICLE SELECTED (Manager selects vehicle)
   ✅ FIX: removed stray '+'
============================================================ */
export const vehicleSelected = async (req, res) => {
  try {
    const key = req.params.flowKey;
    const { vehicleType, vehicleNo } = req.body;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!vehicleType && !vehicleNo)
      return res.status(400).json({
        ok: false,
        message: "vehicleType or vehicleNo required",
      });

    const orderIds = await resolveOrderIdsFromFlowKey(key);

    // 🔥 FORCE FULL ORDER
    let fullOrderId =
      orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

    if (!fullOrderId && orderIds.length === 1) {
      const oid = normalizeOrderId(orderIds[0]);
      fullOrderId = `ORD_FULL_${oid.replace(/^ORD/, "")}`;
    }

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "ORD_FULL order required",
      });
    }

    // ✅ Update ONLY FULL order
    await updateOrders([fullOrderId], {
      UpdateExpression: "SET vehicleType = :v, vehicleNo = :vn",
      ExpressionAttributeValues: {
        ":v": vehicleType || vehicleNo,
        ":vn": vehicleNo || null,
      },
    });

    return res.json({
      ok: true,
      message: "✅ Vehicle selected",
      fullOrderId,
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

// 🔥 ADD HERE
let fullOrderId =
  orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

if (!fullOrderId && orderIds.length > 0) {
  const base = normalizeOrderId(orderIds[0]);
  if (base && !base.startsWith("ORD_FULL_")) {
    fullOrderId = `ORD_FULL_${base.replace(/^ORD/, "")}`;
    orderIds.unshift(fullOrderId);
  }
}

const vehicleOk = await ensureVehicleSelected(orderIds);

    if (!vehicleOk) {
      return res.status(400).json({
        ok: false,
        message: "❌ Vehicle not selected. Select vehicle first.",
      });
    }

    await updateOrders(orderIds, {
      UpdateExpression:
        "SET #s = :st, loadingStarted = :ls, loadingStartedAt = :t",
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

// 🔥 ADD HERE
let fullOrderId =
  orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

if (!fullOrderId && orderIds.length > 0) {
  const base = normalizeOrderId(orderIds[0]);
  if (base && !base.startsWith("ORD_FULL_")) {
    fullOrderId = `ORD_FULL_${base.replace(/^ORD/, "")}`;
    orderIds.unshift(fullOrderId);
  }
}

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
   ✅ ASSIGN DRIVER (FINAL)
============================================================ */
/* ============================================================
   ✅ ASSIGN DRIVER (FINAL – SAFE + MERGE READY)
   - FULL order மட்டும் driverId
   - CHILD orders => MERGED
   - ALL distributors copied into FULL order
   - currentDistributorIndex = 0
   - D1 / D2 reach logic WILL WORK
============================================================ */
export const assignDriver = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });
    if (!driverId)
      return res.status(400).json({ ok: false, message: "driverId required" });

    /* --------------------------------------------------------
       1️⃣ Resolve all orderIds from ANY key
    -------------------------------------------------------- */
    const orderIds = await resolveOrderIdsFromFlowKey(key);

// 🔥 FORCE FULL ORDER (MISSING FIX)
let fullOrderId =
  orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

if (!fullOrderId && orderIds.length > 0) {
  const base = normalizeOrderId(orderIds[0]);
  if (base && !base.startsWith("ORD_FULL_")) {
    fullOrderId = `ORD_FULL_${base.replace(/^ORD/, "")}`;
    orderIds.unshift(fullOrderId);
  }
}
const vehicleOk = await ensureVehicleSelected(orderIds);
    if (!vehicleOk) {
      return res
        .status(400)
        .json({ ok: false, message: "❌ Vehicle not selected" });
    }
    /* --------------------------------------------------------
       2️⃣ Find FULL order (MERGE + DIRECT FULL SAFE)
    -------------------------------------------------------- */
    // merge case: child -> mergedIntoOrderId
    if (!fullOrderId) {
      for (const raw of orderIds) {
        const oid = normalizeOrderId(raw);
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

    // 🔥 DIRECT FULL AUTO-DETECT (even if FE sends ORD123)
    if (!fullOrderId && orderIds.length === 1) {
      const oid = normalizeOrderId(orderIds[0]);
      const tryFullId = oid.startsWith("ORD_FULL_")
        ? oid
        : `ORD_FULL_${oid.replace(/^ORD/, "")}`;

      const fg = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${tryFullId}`, sk: "META" },
        })
      );

      if (fg.Item) fullOrderId = tryFullId;
    }

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "ORD_FULL order required to assign driver",
      });
    }

    const allIds = [...new Set(orderIds.map(normalizeOrderId).filter(Boolean))];
    const childOrderIds = allIds.filter((id) => id !== fullOrderId);

    /* --------------------------------------------------------
       3️⃣ Collect distributors from CHILD orders
    -------------------------------------------------------- */
    let mergedDistributors = [];

    for (const cid of childOrderIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
        })
      );

      const item = g.Item;
      if (!item) continue;

      if (Array.isArray(item.distributors) && item.distributors.length > 0) {
        for (const d of item.distributors) {
          mergedDistributors.push({
            distributorCode: d.distributorCode || null,
            distributorName: d.distributorName || null,
            lat: d.lat != null ? Number(d.lat) : null,
            lng: d.lng != null ? Number(d.lng) : null,
            mapUrl: d.mapUrl || null,
            items: d.items || [],
            reachedAt: null,
            unloadStartAt: null,
            unloadEndAt: null,
          });
        }
      } else if (item.distributorName && item.lat != null && item.lng != null) {
        mergedDistributors.push({
          distributorCode: item.distributorId || null,
          distributorName: item.distributorName,
          lat: Number(item.lat),
          lng: Number(item.lng),
          mapUrl: item.mapUrl || null,
          items: item.items || [],
          reachedAt: null,
          unloadStartAt: null,
          unloadEndAt: null,
        });
      }
    }

    /* --------------------------------------------------------
       4️⃣ Dedupe distributors
    -------------------------------------------------------- */
    const seen = new Set();
    mergedDistributors = mergedDistributors.filter((d) => {
      const k = (d.distributorCode || d.distributorName || "")
        .toString()
        .trim()
        .toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    /* --------------------------------------------------------
       5️⃣ Fallback: take distributors from FULL order
    -------------------------------------------------------- */
    if (mergedDistributors.length === 0) {
      const fg = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
        })
      );

      if (Array.isArray(fg.Item?.distributors)) {
        mergedDistributors = fg.Item.distributors.map((d) => ({
          distributorCode: d.distributorCode || null,
          distributorName: d.distributorName || null,
          lat: d.lat != null ? Number(d.lat) : null,
          lng: d.lng != null ? Number(d.lng) : null,
          mapUrl: d.mapUrl || null,
          items: d.items || [],
          reachedAt: null,
          unloadStartAt: null,
          unloadEndAt: null,
        }));
      }
    }

    /* --------------------------------------------------------
       6️⃣ Driver lookup
    -------------------------------------------------------- */
    const driverPk = normalizeUserPk(driverId);
    const dg = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );

    if (!dg.Item)
      return res.status(404).json({ ok: false, message: "Driver not found" });

    const driverName = dg.Item.name || dg.Item.userName || "Driver";
    const driverMobile = dg.Item.mobile || null;

    /* --------------------------------------------------------
       7️⃣ UPDATE FULL ORDER
    -------------------------------------------------------- */
    await updateOrders([fullOrderId], {
      UpdateExpression: `
        SET #s = :st,
            driverId = :d,
            driverName = :dn,
            driverMobile = :dm,
            vehicleNo = :vn,
            distributors = :dist,
            currentDistributorIndex = :i
      `,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "DRIVER_ASSIGNED",
        ":d": driverPk,
        ":dn": driverName,
        ":dm": driverMobile,
        ":vn": vehicleNo || null,
        ":dist": mergedDistributors,
        ":i": 0,
      },
    });

    /* --------------------------------------------------------
       8️⃣ CHILD ORDERS → MERGED
    -------------------------------------------------------- */
    if (childOrderIds.length > 0) {
      await updateOrders(childOrderIds, {
        UpdateExpression: `
          SET #s = :st,
              mergedIntoOrderId = :mid
          REMOVE driverId, driverName, driverMobile
        `,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":st": "MERGED",
          ":mid": fullOrderId,
        },
      });
    }

    /* --------------------------------------------------------
       9️⃣ Timeline
    -------------------------------------------------------- */
    const user = req.user || {};
    await addTimelineEvent({
      orderId: fullOrderId,
      event: "DRIVER_ASSIGNED",
      by: user?.mobile || "system",
      byUserName: user?.name || user?.userName || null,
      role: user?.role || "MANAGER",
      data: { flowKey: key, driverId: driverPk },
    });

    return res.json({
      ok: true,
      message: "✅ Driver assigned successfully",
      flowKey: key,
      fullOrderId,
      distributors: mergedDistributors.length,
    });
  } catch (err) {
    console.error("assignDriver error", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
};
/* ============================================================
   ✅ NEW: List drivers for dropdown (Manager/Master)
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
      driverId: u.pk,
      name: u.name || u.userName || "Driver",
      mobile: u.mobile || null,
    }));

    return res.json({ ok: true, count: drivers.length, drivers });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
