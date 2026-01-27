import { shouldSendNotification } from "../helpers/notification.helper.js";
import { sendPush } from "./push.service.js";

/**
 * Trigger push notifications for timeline events
 */
export async function triggerTimelineNotification({
  users,   // already resolved & access-filtered users
  order,   // order META
  event,   // timeline event
}) {
  for (const user of users) {
    // 🔥 STEP 2A – preference check
    if (!shouldSendNotification(user, event)) continue;

    const message = buildMessage(order, event, user);
    if (!message) continue;

    await sendPush({
      user,
      title: "Order Update",
      body: message,
      data: {
        orderId: order.orderId,
        event,
      },
    });
  }
}

/* --------------------------------------------------
   MESSAGE BUILDER (ROLE + EVENT BASED)
   OPTION 2: Generic fallback included
-------------------------------------------------- */

function buildMessage(order, event, user) {
  const role = String(user.role || "").toUpperCase();

  const distributor =
    order.distributorName ||
    order.distributor ||
    order.agencyName ||
    "Distributor";

  const amount = formatAmount(order.totalAmount || order.amount);

  /* ---------------- MANAGER ---------------- */
  if (role === "MANAGER") {
    const map = {
      ORDER_CONFIRMED: `Order placed for ${distributor} – ₹${amount}`,
    };

    return map[event] || `Order updated for ${distributor}`;
  }

  /* ---------------- SALES OFFICER ---------------- */
  if (role === "SALES OFFICER" || role === "SALES_OFFICER_VNR" || role === "SALES_OFFICER" ) {
    const map = {
      ORDER_CONFIRMED: `Order placed for ${distributor} – ₹${amount}`,
      SLOT_BOOKING_COMPLETED: `Slot booked for ${distributor} – ₹${amount}`,
      DELIVERY_COMPLETED: `Order delivered for ${distributor}`,
    };

    return map[event] || null;
  }

  /* ---------------- DRIVER ---------------- */
  if (role === "DRIVER") {
    const map = {
      DRIVER_ASSIGNED: `You have been assigned for ${distributor} – ₹${amount}`,
      DRIVE_STARTED: `Delivery started for ${distributor}`,
    };

    return map[event] || null;
  }

  /* ---------------- DISTRIBUTOR ---------------- */
  if (role === "DISTRIBUTOR") {
    const map = {
      ORDER_CONFIRMED: `Your order is received – ₹${amount}`,
      SLOT_BOOKING_COMPLETED: `Slot booked for your order – ₹${amount}`,
      DRIVER_ASSIGNED: `Driver assigned for your order`,
      DRIVE_STARTED: `Your order is out for delivery`,
      DELIVERY_COMPLETED: `Your order has been delivered`,
    };

    // 🔥 fallback ensures ALL events send notification
    return map[event] || `Your order status has been updated`;
  }

  return null;
}

/* --------------------------------------------------
   UTIL
-------------------------------------------------- */

function formatAmount(val) {
  if (!val) return "0";
  return Number(val).toLocaleString("en-IN");
}
