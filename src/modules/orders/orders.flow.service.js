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

  // ✅ SPECIAL: If ORD_FULL_* flowKey
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

  const baseOrd = `ORD${key.replace("ORD_FULL_", "")}`;

  // 🔥 MAIN FIX
  // 👉 If NO merged orders → SINGLE order
  // 👉 Use ONLY base order (ORDxxxx)
  if (merged.length === 0) {
    return [baseOrd];
  }

  // 👉 If merged → FULL + children
  return [key, ...merged]
    .map(normalizeOrderId)
    .filter(Boolean);
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
async function updateOrders(fullOrderId, updatePayload) {
  const orderIds = await resolveOrderIdsFromFlowKey(fullOrderId);
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
        orderIds.unshift(`ORD_FULL_${oid.replace(/^ORD/, "")}`);
      }
    }

    if (orderIds.length === 0) {
      return res.status(404).json({ ok: false, message: "No orders found" });
    }

    /* --------------------------------------------------
       2️⃣ Ensure ORD_FULL META exists
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
                    #st = :s,
                    mergeKey = :m
              `,
              ExpressionAttributeNames: {
                "#st": "status",
              },
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
       3️⃣ Fetch all orders META
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
      return res.status(404).json({ ok: false, message: "Orders meta not found" });
    }

    /* --------------------------------------------------
       4️⃣ FULL ORDER (🔥 MOST IMPORTANT)
    -------------------------------------------------- */
    const fullOrder = orders.find((o) =>
      String(o.orderId || "").startsWith("ORD_FULL_")
    );

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
       7️⃣ ✅ STATUS — ALWAYS FROM ORD_FULL IF EXISTS
    -------------------------------------------------- */
    let status = "UNKNOWN";

    if (fullOrder?.status) {
      status = String(fullOrder.status).toUpperCase();
    } else {
      const priority = [
        "DELIVERED",
        "OUT_FOR_DELIVERY",
        "DRIVER_ASSIGNED",
        "LOADING_COMPLETED",
        "LOADING_STARTED",
        "VEHICLE_SELECTED",
        "SLOT_BOOKED",
        "CONFIRMED",
      ];

      const stList = orders.map((o) =>
        String(o.status || "").toUpperCase()
      );

      for (const p of priority) {
        if (stList.includes(p)) {
          status = p;
          break;
        }
      }
    }

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
      mergeKey: fullOrder?.mergeKey || orders[0]?.mergeKey || null,
      flowKey: fullOrder?.orderId || orders[0]?.orderId,
      masterOrderId: fullOrder?.orderId || orders[0]?.orderId,
      trackingOrderId: fullOrder?.orderId || orders[0]?.orderId,
      orderIds: calcOrders.map((o) => o.orderId).filter(Boolean),
      totalQty,
      grandTotal,
      status,
      vehicleType: fullOrder?.vehicleType || null,
      vehicleNo: fullOrder?.vehicleNo || null,
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

    if (!key) {
      return res.status(400).json({ ok: false, message: "flowKey required" });
    }

    if (!vehicleType && !vehicleNo) {
      return res.status(400).json({
        ok: false,
        message: "vehicleType or vehicleNo required",
      });
    }

    const orderIds = await resolveOrderIdsFromFlowKey(key);

    let fullOrderId =
      orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

    if (!fullOrderId && orderIds.length > 0) {
      const base = normalizeOrderId(orderIds[0]);
      fullOrderId = `ORD_FULL_${base.replace(/^ORD/, "")}`;
    }

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "ORD_FULL order required",
      });
    }

    await updateOrders(fullOrderId, {
      UpdateExpression: `
        SET #s = :st,
            vehicleType = :vt,
            vehicleNo = :vn
      `,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "VEHICLE_SELECTED",
        ":vt": vehicleType || null,
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

    await updateOrders(fullOrderId, {
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

    await updateOrders(fullOrderId, {
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
const DISTRIBUTORS_TABLE =
  process.env.DISTRIBUTORS_TABLE || "tickin_distributors";

async function getDistributorFromMaster(distributorId) {
  if (!distributorId) return null;

  // ✅ Your table keys: pk="DISTRIBUTOR", sk="<D001>"
  const res = await ddb.send(
    new GetCommand({
      TableName: DISTRIBUTORS_TABLE,
      Key: {
        pk: "DISTRIBUTOR",
        sk: String(distributorId), // ex: "D001"
      },
    })
  );

  if (!res.Item) return null;

  // ✅ Your field is final_url
  const mapUrl = res.Item.final_url || res.Item.mapUrl || null;

  // ✅ parse lat/lng from URL if needed
  let lat = Number(res.Item.lat) || null;
  let lng = Number(res.Item.lng) || null;

  if ((!lat || !lng) && mapUrl) {
    const m = String(mapUrl).match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
    if (m) {
      lat = Number(m[1]);
      lng = Number(m[3]);
    }
  }

  return {
    distributorCode: res.Item.distributorCode || String(distributorId),
    distributorName: res.Item.agencyName || res.Item.name || null,
    lat,
    lng,
    mapUrl,
  };
}
/* ============================================================
   ✅ ASSIGN DRIVER (FINAL)
============================================================ */
export const assignDriver = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const { driverId, vehicleNo } = req.body;

    if (!key || !driverId) {
      return res.status(400).json({ ok: false, message: "flowKey & driverId required" });
    }

    const orderIds = await resolveOrderIdsFromFlowKey(key);
    if (!orderIds.length) {
      return res.status(404).json({ ok: false, message: "No orders found" });
    }

    // 🔍 find FULL order
    const fullOrderId =
      orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "Merged flow must have ORD_FULL order",
      });
    }

    const childOrderIds = orderIds.filter((id) => id !== fullOrderId);

    /* --------------------------------------------------
       🔥 BUILD distributors[] FOR FULL ORDER
    -------------------------------------------------- */
    let distributors = [];
 // 🔥 FIX: SINGLE FULL ORDER (no child orders)
if (childOrderIds.length === 0) {
  const g = await ddb.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
    })
  );

  if (g.Item?.distributors?.length) {
    distributors = g.Item.distributors;
  }
}

    for (const cid of childOrderIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
        })
      );
      const o = g.Item;
      console.log("📦 CHILD ORDER META", {
    orderId: cid,
    distributorId: o?.distributorId,
    distributorName: o?.distributorName,
  });
      if (!o) continue;

      // CASE 1: already has distributors[]
      if (Array.isArray(o.distributors) && o.distributors.length) {
  distributors.push(...o.distributors);
  continue;
}
      // CASE 2: single order shape
      // ✅ NEW CORRECT LOGIC
if (!o.distributorId) continue;

const master = await getDistributorFromMaster(o.distributorId);

// ❌ if master location missing, skip
if (!master || !master.lat || !master.lng) continue;

distributors.push({
  distributorCode: master.distributorCode,
  distributorName: master.distributorName || o.distributorName,
  lat: master.lat,
  lng: master.lng,
  mapUrl: master.mapUrl || null,
  items: o.items || [],
  reachedAt: null,
  unloadStartAt: null,
  unloadEndAt: null,
});
    }

    // ❗ dedupe distributors
   const seen = new Set();
distributors = distributors.filter((d) => {
  const k = (d.distributorCode || d.distributorName || "")
    .toString()
    .trim()
    .toUpperCase();
  if (!k || seen.has(k)) return false;
  seen.add(k);
  return true;
});

    if (!distributors.length) {
      return res.status(400).json({
        ok: false,
        message: "No valid distributor locations found for merged order",
      });
    }

    /* --------------------------------------------------
       🔍 Driver lookup
    -------------------------------------------------- */
    const driverPk = normalizeUserPk(driverId);
    const dg = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { pk: driverPk, sk: "PROFILE" },
      })
    );
    if (!dg.Item) {
      return res.status(404).json({ ok: false, message: "Driver not found" });
    }

    /* --------------------------------------------------
       ✅ UPDATE FULL ORDER (🔥 KEY FIX)
    -------------------------------------------------- */
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
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
          ":dn": dg.Item.name || "Driver",
          ":dm": dg.Item.mobile || null,
          ":vn": vehicleNo || null,
          ":dist": distributors,
          ":i": 0,
        },
      })
    );

    /* --------------------------------------------------
       CHILD ORDERS → MERGED
    -------------------------------------------------- */
    for (const cid of childOrderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
          UpdateExpression:
            "SET #s = :st, mergedIntoOrderId = :mid REMOVE driverId, driverName, driverMobile",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "MERGED",
            ":mid": fullOrderId,
          },
        })
      );
    }

    return res.json({
      ok: true,
      message: "✅ Driver assigned (MERGED READY)",
      fullOrderId,
      distributorCount: distributors.length,
    });
  } catch (err) {
    console.error(err);
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
