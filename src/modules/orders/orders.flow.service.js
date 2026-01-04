import { ddb } from "../../config/dynamo.js";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { addTimelineEvent } from "../timeline/timeline.helper.js";

const ORDERS_TABLE = process.env.ORDERS_TABLE || "tickin_orders";
const USERS_TABLE = process.env.USERS_TABLE || "tickin_users";

function normalizeUserPk(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  return s.startsWith("USER#") ? s : `USER#${s}`;
}

// ✅ 1) Vehicle Selected
export const vehicleSelected = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { vehicleType } = req.body;
    const user = req.user;

    if (!vehicleType) return res.status(400).json({ ok: false, message: "vehicleType required" });

    await ddb.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression: "SET vehicleType = :v, vehicleSelectedAt = :t",
      ExpressionAttributeValues: {
        ":v": String(vehicleType).toUpperCase(),
        ":t": new Date().toISOString()
      }
    }));

    await addTimelineEvent({
      orderId,
      event: "VEHICLE_SELECTED",
      by: user.mobile,
      extra: { vehicleType }
    });

    return res.json({ ok: true, message: "✅ Vehicle selected", orderId, vehicleType });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

// ✅ 2) Loading Start
export const loadingStart = async (req, res) => {
  try {
    const { orderId } = req.body;
    const user = req.user;

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: "orderId required",
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { pk: `ORDER#${orderId}`, sk: "META" },

        // 🔴 IMPORTANT CHANGE HERE
        UpdateExpression: `
          SET 
            loadingStarted = :ls,
            loadingStartedAt = :t
        `,
        ExpressionAttributeValues: {
          ":ls": true,
          ":t": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent({
      orderId,
      event: "LOADING_STARTED",
      by: user.mobile,
      extra: { role: user.role },
    });

    return res.json({
      ok: true,
      message: "✅ Loading started",
      orderId,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
};



// ✅ 3) Loading Item (each by each)
export const loadingItem = async (req, res) => {
  try {
    const { orderId, productId, qty } = req.body;
    const user = req.user;

    if (!orderId || !productId || !qty) {
      return res.status(400).json({ ok: false, message: "orderId, productId, qty required" });
    }

    await addTimelineEvent({
      orderId,
      event: "LOADING_ITEM",
      by: user.mobile,
      extra: { productId, qty }
    });

    return res.json({ ok: true, message: "✅ Loading item added", orderId, productId, qty });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

// ✅ 4) Loading End
export const loadingEnd = async (req, res) => {
  try {
    const { orderId } = req.body;
    const user = req.user;

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });

    await ddb.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression: "SET #s = :st, loadingEndAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "LOADING_COMPLETED",
        ":t": new Date().toISOString()
      }
    }));

    await addTimelineEvent({
      orderId,
      event: "LOADING_COMPLETED",
      by: user.mobile,
      extra: { role: user.role }
    });

    return res.json({ ok: true, message: "✅ Loading completed", orderId });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

// ✅ 5) Assign Driver
export const assignDriverToOrder = async (req, res) => {
  try {
    const { orderId, driverId, vehicleNo } = req.body;
    const user = req.user;

    if (!orderId || !driverId) {
      return res.status(400).json({ ok: false, message: "orderId + driverId required" });
    }

    const driverPk = normalizeUserPk(driverId);

    // ✅ validate driver exists in tickin_users
    const driverRes = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: driverPk, sk: "PROFILE" }
    }));

    if (!driverRes.Item || String(driverRes.Item.role || "").toUpperCase() !== "DRIVER") {
      return res.status(400).json({ ok: false, message: "Invalid driverId (not a DRIVER)" });
    }

    const driver = driverRes.Item;

    // ✅ Update order
    await ddb.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { pk: `ORDER#${orderId}`, sk: "META" },
      UpdateExpression: "SET #s = :st, driverId = :d, driverName = :n, driverMobile = :m, vehicleNo = :v, driverAssignedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": "DRIVER_ASSIGNED",
        ":d": driverPk,
        ":n": driver.name || null,
        ":m": driver.mobile || null,
        ":v": vehicleNo || null,
        ":t": new Date().toISOString()
      }
    }));

    await addTimelineEvent({
      orderId,
      event: "DRIVER_ASSIGNED",
      by: user.mobile,
      extra: {
        driverId: driverPk,
        driverName: driver.name,
        driverMobile: driver.mobile,
        vehicleNo: vehicleNo || null
      }
    });

    return res.json({
      ok: true,
      message: "✅ Driver assigned",
      orderId,
      driver: {
        driverId: driverPk,
        name: driver.name,
        mobile: driver.mobile,
        vehicleNo: vehicleNo || null
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
