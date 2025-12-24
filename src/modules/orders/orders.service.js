import { ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../config/dynamo.js";
import { v4 as uuidv4 } from "uuid";
import { addTimelineEvent } from "../timeline/timeline.helper.js";
import { bookSlot } from "../slot/slot.service.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

// ✅ Confirm Draft Order (DRAFT → PENDING) — Salesman only
export const confirmDraftOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    // ✅ get order
    const existing = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = existing.Item;

    // ✅ only creator confirm
    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can confirm" });
    }

    // ✅ only draft confirm
    if (order.status !== "DRAFT") {
      return res.status(403).json({ message: "Order already confirmed" });
    }

    // ✅ update status to PENDING
    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "set #st = :p, confirmedAt = :t",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":p": "PENDING",
          ":t": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent(
      orderId,
      "ORDER_CONFIRMED",
      `Order confirmed by Salesman`,
      user.mobile,
      user.role
    );

    return res.json({
      message: "✅ Order confirmed successfully",
      orderId,
      status: "PENDING",
      totalAmount: order.totalAmount,
      distributorName: order.distributorName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
// ✅ CREATE ORDER (Sales Officer only)
export const createOrder = async (req, res) => {
  try {
    const user = req.user;
    const { distributorId, distributorName, items } = req.body;

    if (!distributorId || !distributorName) {
      return res.status(400).json({ message: "DistributorId + DistributorName required" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items required" });
    }

    // ✅ Build finalItems by fetching products
    let finalItems = [];
    let totalAmount = 0;

    for (const it of items) {
      const pid = it.productId.startsWith("P#") ? it.productId : `P#${it.productId}`;

      const prodRes = await ddb.send(
        new GetCommand({
          TableName: "tickin_products",
          Key: {
            pk: "PRODUCT",
            sk: pid
          }
        })
      );

      if (!prodRes.Item) {
        return res.status(400).json({ message: `Product not found: ${it.productId}` });
      }

      const prod = prodRes.Item;
      const itemTotal = Number(it.qty) * Number(prod.price);

      finalItems.push({
        productId: prod.productId,
        name: prod.name,
        category: prod.category,
        price: prod.price,
        qty: it.qty,
        total: itemTotal
      });

      totalAmount += itemTotal;
    }

    const orderId = "ORD" + uuidv4().slice(0, 8);

    const orderItem = {
      pk: `ORDER#${orderId}`,
      sk: "META",
      orderId,
      distributorId,
      distributorName,
      items: finalItems,
      totalAmount,
      status: "DRAFT",
      pendingReason: "",
      createdBy: user.mobile,
      createdRole: user.role,
      createdAt: new Date().toISOString()
    };

    await ddb.send(new PutCommand({
      TableName: "tickin_orders",
      Item: orderItem
    }));

    await addTimelineEvent(
      orderId,
      "ORDER_DRAFT_CREATED",
      `Draft created by ${user.role}`,
      user.mobile,
      user.role
    );

    return res.json({
      message: "Order created ✅",
      orderId,
      status: "DRAFT",
      distributorName,
      totalAmount,
      orderCard: {
        distributor: distributorName,
        items: finalItems,
        grandTotal: totalAmount,
        status: "DRAFT"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

// ✅ Pending Orders (Master / Manager)
export const getPendingOrders = async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "#st = :pending",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":pending": "PENDING" },
      })
    );

    return res.json({
      message: "Pending orders fetched",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

// ✅ Today Orders (Master only)
export const getTodayOrders = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "begins_with(#dt, :today)",
        ExpressionAttributeNames: { "#dt": "createdAt" },
        ExpressionAttributeValues: { ":today": today },
      })
    );

    return res.json({
      message: "Today orders fetched",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

// ✅ Delivery Orders (Master only)
export const getDeliveryOrders = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const result = await ddb.send(
      new ScanCommand({
        TableName: "tickin_orders",
        FilterExpression: "#dd = :today",
        ExpressionAttributeNames: { "#dd": "deliveryDate" },
        ExpressionAttributeValues: { ":today": today },
      })
    );

    return res.json({
      message: "Delivery orders fetched",
      count: result.Items?.length || 0,
      orders: result.Items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

// ✅ Update Pending Reason (Manager only)
export const updatePendingReason = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;
    const user = req.user;

    if (!reason) return res.status(400).json({ message: "Reason required" });

    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "set pendingReason = :r",
        ExpressionAttributeValues: { ":r": reason },
      })
    );

    await addTimelineEvent(
      orderId,
      "REASON_UPDATED",
      `Reason updated: ${reason}`,
      user.mobile,
      user.role
    );

    return res.json({ message: "Pending reason updated successfully", orderId, reason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};

// ✅ Confirm Order + Slot Booking (Master/Manager)
export const confirmOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    const { slot, companyCode, distributorId } = req.body;

    if (!companyCode) {
      return res.status(400).json({ message: "companyCode required" });
    }

    // ✅ Update order status CONFIRMED
    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "set #st = :c, confirmedBy = :u, confirmedAt = :t",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":u": user.mobile,
          ":t": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent(
      orderId,
      "ORDER_CONFIRMED",
      `Order confirmed by ${user.role}`,
      user.mobile,
      user.role
    );

    // ✅ SLOT BOOKING
    if (slot?.date && slot?.time && slot?.vehicleType && slot?.pos) {
      await bookSlot({
        companyCode,
        date: slot.date,
        time: slot.time,
        vehicleType: slot.vehicleType,
        pos: slot.pos,
        userId: user.mobile,
        distributorCode: distributorId || null,
      });

      await addTimelineEvent(
        orderId,
        "SLOT_BOOKED",
        `Slot booked: ${slot.time} (${slot.vehicleType}-${slot.pos})`,
        user.mobile,
        user.role
      );
    }

    return res.json({
      message: "Order confirmed successfully",
      orderId,
      slotBooked: !!slot,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};
export const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    return res.json({
      message: "Order fetched ✅",
      order: result.Item,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
export const updateOrderItems = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items } = req.body;
    const user = req.user;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items required" });
    }

    // ✅ get existing order
    const existing = await ddb.send(
      new GetCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
      })
    );

    if (!existing.Item) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = existing.Item;

    // ✅ Only creator can edit
    if (order.createdBy !== user.mobile) {
      return res.status(403).json({ message: "Only creator can edit" });
    }

    // ✅ Only DRAFT editable
    if (order.status !== "DRAFT") {
      return res.status(403).json({ message: "Order already confirmed. Cannot edit." });
    }

    // ✅ recalc total
    let totalAmount = 0;
    items.forEach((i) => {
      totalAmount += Number(i.qty) * Number(i.price);
    });

    // ✅ update order
    await ddb.send(
      new UpdateCommand({
        TableName: "tickin_orders",
        Key: { pk: `ORDER#${orderId}`, sk: "META" },
        UpdateExpression: "set items = :it, totalAmount = :ta, updatedAt = :u",
        ExpressionAttributeValues: {
          ":it": items,
          ":ta": totalAmount,
          ":u": new Date().toISOString(),
        },
      })
    );

    await addTimelineEvent(
      orderId,
      "ORDER_UPDATED",
      "Order updated by Salesman",
      user.mobile,
      user.role
    );

    return res.json({
      message: "✅ Order updated successfully",
      orderId,
      status: "DRAFT",
      totalAmount,
      items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error", error: err.message });
  }
};
