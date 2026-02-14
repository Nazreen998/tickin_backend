// orders.flow.service.js  ✅ FINAL FIXED
import { ddb } from "../../config/dynamo.js";
import { GetCommand, UpdateCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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

  // 🔥 MAIN FIX
  // 👉 If NO merged orders → SINGLE order
  // 👉 Use ONLY base order (ORDxxxx)
  if (merged.length === 0) {
  const baseOrd = `ORD${key.replace("ORD_FULL_", "")}`;
  return [key, baseOrd].map(normalizeOrderId).filter(Boolean);
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
const tryIds = [oid];

// only for numeric orders like "123"
if (/^\d+$/.test(oid)) tryIds.push(`ORD${oid}`);

// only for ORDxxxx (not FULL)
if (oid.startsWith("ORD") && !oid.startsWith("ORD_FULL_")) {
  tryIds.push(oid.replace(/^ORD/, ""));
}

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
  try {
    console.log("🔥 FLOW SERVICE HIT", req.params.flowKey);

    let key = String(req.params.flowKey || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, message: "flowKey required" });
    }

    /* --------------------------------------------------
       0️⃣ HARD GUARD: if ORDxxxx passed, prefer ORD_FULL_xxxx if exists
    -------------------------------------------------- */
    if (key.startsWith("ORD") && !key.startsWith("ORD_FULL_")) {
      const fullKey = `ORD_FULL_${key.replace(/^ORD/, "")}`;

      const fg = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${fullKey}`, sk: "META" },
        })
      );

      if (fg.Item) {
        key = fullKey;
      }
    }

    /* --------------------------------------------------
       1️⃣ Resolve orderIds from ANY key
    -------------------------------------------------- */
    let orderIds = await resolveOrderIdsFromFlowKey(key);
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
      return res
        .status(404)
        .json({ ok: false, message: "Orders meta not found" });
    }

    /* --------------------------------------------------
       4️⃣ FULL ORDER (MASTER)
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
       7️⃣ STATUS — ALWAYS FROM ORD_FULL IF EXISTS
    -------------------------------------------------- */
    let status = "CONFIRMED";

    if (fullOrder?.status) {
      status = String(fullOrder.status).toUpperCase();
    } else {
      const priority = [
        "DELIVERY_COMPLETED",
        "DELIVERED",
        "OUT_FOR_DELIVERY",
        "DRIVER_ASSIGNED",
        "LOADING_COMPLETED",
        "LOADING_STARTED",
        "VEHICLE_SELECTED",
        "SLOT_BOOKED",
        "CONFIRMED",
      ];

      const stList = orders.map((o) => String(o.status || "").toUpperCase());

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
// ✅ Distributors (Dynamic Dn)
let distributorSource = calcOrders;

// If FULL order has mergedOrderIds, use that exact order sequence
if (fullOrder && Array.isArray(fullOrder.mergedOrderIds) && fullOrder.mergedOrderIds.length) {
  distributorSource = [];
  for (const cid of fullOrder.mergedOrderIds) {
    const g = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${cid}`, sk: "META" },
      })
    );
    if (g.Item) distributorSource.push(g.Item);
  }
}

const distributors = distributorSource.map((o, idx) => ({
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
    : distributors.map((d) => `${d.label}: ${d.distributorName || "-"}`).join(" | ");

    /* --------------------------------------------------
       9️⃣ DRIVER DETAILS (🔥 MAIN FIX)
       Always from FULL order (master)
    -------------------------------------------------- */
    const driverId = fullOrder?.driverId || null;
    const driverName = fullOrder?.driverName || null;
    const driverMobile = fullOrder?.driverMobile || null;

    /* --------------------------------------------------
       🔟 SLOT DETAILS (for manager flow summary)
    -------------------------------------------------- */
    const slotDate = fullOrder?.slotDate || null;
    const slotTime = fullOrder?.slotTime || null;
    const slotPos = fullOrder?.slotPos || null;

    /* --------------------------------------------------
       11️⃣ RESPONSE
    -------------------------------------------------- */
    return res.json({
      ok: true,

      mergeKey: fullOrder?.mergeKey || orders[0]?.mergeKey || null,

      flowKey: fullOrder?.orderId || orders[0]?.orderId,
      masterOrderId: fullOrder?.orderId || orders[0]?.orderId,
      trackingOrderId: fullOrder?.orderId || orders[0]?.orderId,

      // 🔥 important for flutter
      fullOrderId: fullOrder?.orderId || null,

      orderIds: calcOrders.map((o) => o.orderId).filter(Boolean),

      totalQty,
      grandTotal,

      status: String(status || "").toUpperCase(),

     vehicleType:
  fullOrder?.vehicleType ||
  orders.find(o => o.vehicleType)?.vehicleType ||
  null,

vehicleNo:
  fullOrder?.vehicleNo ||
  orders.find(o => o.vehicleNo)?.vehicleNo ||
  null,
  
      // ✅ slot
      slotDate,
      slotTime,
      slotPos,

      // ✅ driver
      driverId,
      driverName,
      driverMobile,

      loadingItems,
      distributors,
      distributorDisplay,

      // child orders only
      orders: calcOrders,
    });
  } catch (err) {
    console.error("getOrderFlowByKey error", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
};
export const slotCompleted = async (req, res) => {
  try {
    const key = req.body.flowKey || req.body.mergeKey || req.body.orderId;
    const user = req.user;

    if (!key)
      return res.status(400).json({ ok: false, message: "flowKey required" });

    // 1️⃣ Resolve orders
    let orderIds = await resolveOrderIdsFromFlowKey(key);
    orderIds = orderIds.map(normalizeOrderId).filter(Boolean);

    // only base orders
    const childOrderIds = orderIds.filter((x) => !String(x).startsWith("ORD_FULL_"));

    if (!childOrderIds.length)
      return res.status(400).json({ ok: false, message: "No child orders found" });

    // 2️⃣ Build FULL id
    const base = childOrderIds[0];
    const fullOrderId = `ORD_FULL_${String(base).replace(/^ORD/, "")}`;

    // 3️⃣ Read first child meta (for slot info)
    const baseRes = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${base}`, sk: "META" },
      })
    );

    const baseMeta = baseRes.Item;
    if (!baseMeta)
      return res.status(404).json({ ok: false, message: "Base order meta missing" });

    const slotDate = baseMeta.slotDate || baseMeta.slot?.date || null;
    const slotTime = baseMeta.slotTime || baseMeta.slot?.time || null;
    const slotPos = baseMeta.slotPos || baseMeta.slot?.pos || null;

    if (!slotDate || !slotTime || !slotPos) {
      return res.status(400).json({
        ok: false,
        message: "Slot not booked. Cannot complete slot.",
      });
    }

    const companyCode = baseMeta.companyCode || "VAGR_IT";
    const bookingPk = `COMPANY#${companyCode}#DATE#${slotDate}`;

    // 4️⃣ Create FULL meta if not exists
    const fg = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
      })
    );

    if (!fg.Item) {
      // calculate totals from child orders
      let totalQty = 0;
      let totalAmount = 0;
      const distributors = [];

      for (const cid of childOrderIds) {
        const cRes = await ddb.send(
          new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { pk: `ORDER#${cid}`, sk: "META" },
          })
        );
        const o = cRes.Item;
        if (!o) continue;

        totalQty += Number(o.totalQty || 0);
        totalAmount += Number(o.totalAmount || 0);

        if (o.distributorId || o.distributorName) {
          distributors.push({
            distributorId: o.distributorId || null,
            distributorName: o.distributorName || null,
            orderId: o.orderId || cid,
          });
        }
      }

      await ddb.send(
        new PutCommand({
          TableName: ORDERS_TABLE,
          Item: {
            pk: `ORDER#${fullOrderId}`,
            sk: "META",
            orderId: fullOrderId,

            status: "SLOT_BOOKING_COMPLETED",

            isMerged: childOrderIds.length > 1,
            mergedOrderIds: childOrderIds,

            distributorId: baseMeta.distributorId || null,
            distributorName: baseMeta.distributorName || null,

            items: baseMeta.items || [],
            totalQty,
            totalAmount,
            grandTotal: totalAmount,

            distributors,
            currentDistributorIndex: 0,

            slotBooked: true,
            slotDate,
            slotTime,
            slotPos,
            slotVehicleType: "FULL",
            vehicleType: "FULL",

            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        })
      );
    }

    // 5️⃣ Update all child orders
    for (const cid of childOrderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
          UpdateExpression:
            "SET mergedIntoOrderId = :mid, #s = :st, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":mid": fullOrderId,
            ":st": "SLOT_BOOKING_COMPLETED",
            ":u": new Date().toISOString(),
          },
        })
      );
    }

    // 6️⃣ BOOKINGS update
    // child bookings => MERGED
    for (const cid of childOrderIds) {
      const childScan = await ddb.send(
        new ScanCommand({
          TableName: BOOKINGS_TABLE,
          FilterExpression: "#pk = :pk AND orderId = :oid",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: {
            ":pk": bookingPk,
            ":oid": cid,
          },
        })
      );

      const b = (childScan.Items || [])[0];
      if (!b) continue;

      await ddb.send(
        new UpdateCommand({
          TableName: BOOKINGS_TABLE,
          Key: { pk: b.pk, sk: b.sk },
          UpdateExpression:
            "SET #s = :st, mergedIntoOrderId = :mid, updatedAt = :u, isActive = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "MERGED",
            ":mid": fullOrderId,
            ":u": new Date().toISOString(),
            ":t": true,
          },
        })
      );
    }

    // FULL booking => create if missing
    const fullBookingSk = `SLOT#${slotTime}#POS#${slotPos}#ORDER#${fullOrderId}`;

    const fullBookingRes = await ddb.send(
      new GetCommand({
        TableName: BOOKINGS_TABLE,
        Key: { pk: bookingPk, sk: fullBookingSk },
      })
    );

    if (!fullBookingRes.Item) {
      await ddb.send(
        new PutCommand({
          TableName: BOOKINGS_TABLE,
          Item: {
            pk: bookingPk,
            sk: fullBookingSk,
            companyCode,
            date: slotDate,
            slotDate,
            slotTime,
            slotPos,
            slotVehicleType: "FULL",
            vehicleType: "FULL",
            orderId: fullOrderId,

            distributorCode: baseMeta.distributorId || null,
            distributorName: baseMeta.distributorName || null,

            amount: Number(baseMeta.totalAmount || 0),
            status: "CONFIRMED",
            isActive: true,

            createdAt: new Date().toISOString(),
            createdBy: user.mobile || null,
            mergeKey: baseMeta.mergeKey || null,
            mergedIntoOrderId: null,
            type: "FULL",
          },
        })
      );
    }

    // 7️⃣ Timeline
    await addTimelineEvent({
      orderId: fullOrderId,
      event: "SLOT_BOOKING_COMPLETED",
      by: user.mobile,
      byUserName: user?.name || user?.userName || null,
      role: user?.role || "MANAGER",
      data: { flowKey: key },
    });

    for (const cid of childOrderIds) {
      await addTimelineEvent({
        orderId: cid,
        event: "SLOT_BOOKING_COMPLETED",
        by: user.mobile,
        byUserName: user?.name || user?.userName || null,
        role: user?.role || "MANAGER",
        data: { mergedIntoOrderId: fullOrderId },
      });
    }

    return res.json({
      ok: true,
      message: "✅ SLOT COMPLETED → ORD_FULL created",
      fullOrderId,
      childOrderIds,
    });
  } catch (err) {
    console.error("slotCompleted error:", err);
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
      return res.status(400).json({
        ok: false,
        message: "flowKey & driverId required",
      });
    }

    /* --------------------------------------------------
       1️⃣ Resolve orderIds
    -------------------------------------------------- */
    let orderIds = await resolveOrderIdsFromFlowKey(key);
    if (!orderIds.length) {
      return res.status(404).json({ ok: false, message: "No orders found" });
    }

    orderIds = orderIds.map(normalizeOrderId).filter(Boolean);

    /* --------------------------------------------------
       2️⃣ Find / ensure FULL order
    -------------------------------------------------- */
    let fullOrderId =
      orderIds.find((x) => String(x).startsWith("ORD_FULL_")) || null;

    if (!fullOrderId) {
      const base = orderIds[0];
      fullOrderId = base
        ? `ORD_FULL_${String(base).replace(/^ORD/, "")}`
        : null;

      if (fullOrderId) orderIds = [fullOrderId, ...orderIds];
    }

    if (!fullOrderId) {
      return res.status(400).json({
        ok: false,
        message: "ORD_FULL order required",
      });
    }

    let childOrderIds = orderIds.filter((id) => id !== fullOrderId);

    // 🔥 single FULL fallback
    if (childOrderIds.length === 0) {
      const baseOrd = `ORD${fullOrderId.replace("ORD_FULL_", "")}`;
      childOrderIds = [baseOrd];
    }

    /* --------------------------------------------------
       3️⃣ Read FULL META
    -------------------------------------------------- */
    const fg = await ddb.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
      })
    );

    const fullMeta = fg.Item || {};

    /* --------------------------------------------------
       4️⃣ Build distributors + totals from CHILD orders
    -------------------------------------------------- */
    let distributors = [];
    let totalQty = 0;
    let totalAmount = 0;

    for (const cid of childOrderIds) {
      const g = await ddb.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
        })
      );

      const o = g.Item;
      if (!o) continue;

      totalQty += Number(o.totalQty || o.qty || 0);
      totalAmount += Number(o.totalAmount || o.grandTotal || 0);

      if (Array.isArray(o.distributors) && o.distributors.length) {
        distributors.push(...o.distributors);
        continue;
      }

      if (!o.distributorId) continue;

      const master = await getDistributorFromMaster(o.distributorId);
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

    /* --------------------------------------------------
       5️⃣ LAST fallback → FULL meta distributor
    -------------------------------------------------- */
    if (!distributors.length && fullMeta?.distributorId) {
      const master = await getDistributorFromMaster(fullMeta.distributorId);
      if (master && master.lat && master.lng) {
        distributors.push({
          distributorCode: master.distributorCode,
          distributorName: master.distributorName || fullMeta.distributorName,
          lat: master.lat,
          lng: master.lng,
          mapUrl: master.mapUrl || null,
          items: fullMeta.items || [],
          reachedAt: null,
          unloadStartAt: null,
          unloadEndAt: null,
        });
      }
    }

    // dedupe distributors
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
        message: "No valid distributor locations found",
      });
    }

    /* --------------------------------------------------
       6️⃣ Driver lookup
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

    const driverName =
      dg.Item.name || dg.Item.userName || dg.Item.fullName || "Driver";

    const driverMobile =
      dg.Item.mobile || dg.Item.phone || dg.Item.userMobile || null;

    const distributorDisplay =
      distributors.length === 1
        ? distributors[0].distributorName
        : distributors
            .map((d, i) => `D${i + 1}: ${d.distributorName}`)
            .join(" | ");

    /* --------------------------------------------------
       7️⃣ UPDATE FULL ORDER (🔥 MAIN)
       🔥 IMPORTANT: store driverId as raw id, not pk
    -------------------------------------------------- */
    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${fullOrderId}`, sk: "META" },
        UpdateExpression: `
          SET #s = :st,
              driverId = :d,
              driverPk = :dpk,
              driverName = :dn,
              driverMobile = :dm,
              vehicleNo = :vn,
              distributors = :dist,
              currentDistributorIndex = :i,
              totalQty = :tq,
              totalAmount = :ta,
              grandTotal = :ta,
              distributorDisplay = :dd,
              updatedAt = :u
        `,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":st": "DRIVER_ASSIGNED",
          ":d": String(driverId).trim(), // ✅ RAW
          ":dpk": driverPk,              // optional
          ":dn": driverName,
          ":dm": driverMobile,
          ":vn": vehicleNo || null,
          ":dist": distributors,
          ":i": 0,
          ":tq": totalQty,
          ":ta": totalAmount,
          ":dd": distributorDisplay,
          ":u": new Date().toISOString(),
        },
      })
    );

    /* --------------------------------------------------
       8️⃣ CHILD ORDERS UPDATE
       🔥 DO NOT REMOVE driverName/mobile
       (because timeline screen reads from child sometimes)
    -------------------------------------------------- */
    for (const cid of childOrderIds) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { pk: `ORDER#${cid}`, sk: "META" },
          UpdateExpression: `
            SET #s = :st,
                mergedIntoOrderId = :mid,
                driverId = :d,
                driverName = :dn,
                driverMobile = :dm,
                vehicleNo = :vn,
                updatedAt = :u
          `,
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "DRIVER_ASSIGNED",
            ":mid": fullOrderId,
            ":d": String(driverId).trim(),
            ":dn": driverName,
            ":dm": driverMobile,
            ":vn": vehicleNo || null,
            ":u": new Date().toISOString(),
          },
        })
      );
    }
/* --------------------------------------------------
   9️⃣ BOOKINGS TABLE UPDATE (REAL FIX)
   - find bookings by pk + orderId
   - update using actual pk+sk
-------------------------------------------------- */
try {
  // slotDate mandatory
  const slotDate =
    fullMeta.slotDate ||
    fullMeta.slot?.date ||
    null;

  const slotTime =
    fullMeta.slotTime ||
    fullMeta.slot?.time ||
    null;

  const companyCode = fullMeta.companyCode || "VAGR_IT";

  if (slotDate) {
    const bookingPk = `COMPANY#${companyCode}#DATE#${slotDate}`;

    // 🔥 Update FULL booking
    const fullBookingScan = await ddb.send(
      new ScanCommand({
        TableName: BOOKINGS_TABLE,
        FilterExpression: "#pk = :pk AND orderId = :oid",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: {
          ":pk": bookingPk,
          ":oid": fullOrderId,
        },
      })
    );

    const fullBooking = (fullBookingScan.Items || [])[0];

    if (fullBooking) {
      await ddb.send(
        new UpdateCommand({
          TableName: BOOKINGS_TABLE,
          Key: { pk: fullBooking.pk, sk: fullBooking.sk },
          UpdateExpression:
            "SET #s = :st, updatedAt = :u, isActive = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "DRIVER_ASSIGNED",
            ":u": new Date().toISOString(),
            ":t": true,
          },
        })
      );
    }

    // 🔥 Update CHILD bookings (MERGED + mergedIntoOrderId)
    for (const cid of childOrderIds) {
      const childScan = await ddb.send(
        new ScanCommand({
          TableName: BOOKINGS_TABLE,
          FilterExpression: "#pk = :pk AND orderId = :oid",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: {
            ":pk": bookingPk,
            ":oid": cid,
          },
        })
      );

      const childBooking = (childScan.Items || [])[0];
      if (!childBooking) continue;

      await ddb.send(
        new UpdateCommand({
          TableName: BOOKINGS_TABLE,
          Key: { pk: childBooking.pk, sk: childBooking.sk },
          UpdateExpression:
            "SET #s = :st, mergedIntoOrderId = :mid, updatedAt = :u, isActive = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":st": "MERGED",
            ":mid": fullOrderId,
            ":u": new Date().toISOString(),
            ":t": true,
          },
        })
      );
    }
  }
} catch (e) {
  console.log("⚠️ BOOKINGS update failed:", e.message);
}
    return res.json({
      ok: true,
      message: "✅ Driver assigned successfully",
      fullOrderId,
      totalQty,
      totalAmount,
      distributorDisplay,
      driverName,
      driverMobile,
      vehicleNo,
    });
  } catch (err) {
    console.error("assignDriver error:", err);
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
