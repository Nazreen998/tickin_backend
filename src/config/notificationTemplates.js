export const NOTIFICATION_TEMPLATES = {
  /* ================= ORDER CONFIRMED ================= */
  ORDER_CONFIRMED: {
    MANAGER: ({ orderNo, distributorName, amount }) => ({
      title: "Order Confirmed ✅",
      message: `Order #${orderNo} confirmed for ${distributorName} (₹${amount})`,
    }),

    SALES_OFFICER: ({ orderNo, distributorName, amount }) => ({
      title: "Order Confirmed",
      message: `${distributorName} order #${orderNo} confirmed (₹${amount})`,
    }),

    "SALES OFFICER": ({ orderNo, distributorName, amount }) => ({
      title: "Order Confirmed",
      message: `${distributorName} order #${orderNo} confirmed (₹${amount})`,
    }),

    SALES_OFFICER_VNR: ({ orderNo, distributorName, amount }) => ({
      title: "Order Confirmed",
      message: `${distributorName} VNR order #${orderNo} confirmed (₹${amount})`,
    }),

    "SALES OFFICER VNR": ({ orderNo, distributorName, amount }) => ({
      title: "Order Confirmed",
      message: `${distributorName} VNR order #${orderNo} confirmed (₹${amount})`,
    }),

    DISTRIBUTOR: ({ orderNo, amount }) => ({
      title: "Your Order Confirmed 🎉",
      message: `Your order #${orderNo} is confirmed. Amount ₹${amount}`,
    }),

    DRIVER: ({ distributorName, amount }) => ({
      title: "New Delivery Assigned 🚚",
      message: `Delivery for ${distributorName}. Amount ₹${amount}`,
    }),
  },

  /* ================= SLOT BOOKING COMPLETED ================= */
  SLOT_BOOKING_COMPLETED: {
    MANAGER: ({ orderNo, slotTime }) => ({
      title: "Slot Booked ⏰",
      message: `Order #${orderNo} slot booked at ${slotTime}`,
    }),

    SALES_OFFICER: ({ distributorName, slotTime }) => ({
      title: "Slot Booking Completed",
      message: `${distributorName} slot booked at ${slotTime}`,
    }),

    "SALES OFFICER": ({ distributorName, slotTime }) => ({
      title: "Slot Booking Completed",
      message: `${distributorName} slot booked at ${slotTime}`,
    }),

    SALES_OFFICER_VNR: ({ distributorName, slotTime }) => ({
      title: "Slot Booking Completed",
      message: `${distributorName} VNR slot booked at ${slotTime}`,
    }),

    "SALES OFFICER VNR": ({ distributorName, slotTime }) => ({
      title: "Slot Booking Completed",
      message: `${distributorName} VNR slot booked at ${slotTime}`,
    }),

    DISTRIBUTOR: ({ slotTime }) => ({
      title: "Slot Confirmed ✅",
      message: `Your delivery slot is confirmed at ${slotTime}`,
    }),
  },

  /* ================= DELIVERY COMPLETED ================= */
  DELIVERY_COMPLETED: {
    MANAGER: ({ orderNo }) => ({
      title: "Delivery Completed 📦",
      message: `Order #${orderNo} delivered successfully`,
    }),

    SALES_OFFICER: ({ distributorName, orderNo }) => ({
      title: "Delivery Completed",
      message: `${distributorName} order #${orderNo} delivered`,
    }),

    "SALES OFFICER": ({ distributorName, orderNo }) => ({
      title: "Delivery Completed",
      message: `${distributorName} order #${orderNo} delivered`,
    }),

    SALES_OFFICER_VNR: ({ distributorName, orderNo }) => ({
      title: "Delivery Completed",
      message: `${distributorName} VNR order #${orderNo} delivered`,
    }),

    "SALES OFFICER VNR": ({ distributorName, orderNo }) => ({
      title: "Delivery Completed",
      message: `${distributorName} VNR order #${orderNo} delivered`,
    }),

    DISTRIBUTOR: ({ orderNo }) => ({
      title: "Delivery Successful 🎉",
      message: `Your order #${orderNo} has been delivered`,
    }),
  },

  /* ================= DRIVER ASSIGNED ================= */
  DRIVER_ASSIGNED: {
    DRIVER: ({ distributorName, orderNo }) => ({
      title: "Trip Assigned 🚚",
      message: `You are assigned for ${distributorName} (Order #${orderNo})`,
    }),
  },

  /* ================= DRIVE STARTED ================= */
  DRIVE_STARTED: {
    DRIVER: ({ distributorName }) => ({
      title: "Trip Started 🚛",
      message: `Trip started for ${distributorName}`,
    }),

    DISTRIBUTOR: () => ({
      title: "Delivery Started 🚚",
      message: `Your order is out for delivery`,
    }),
  },

  /* ================= REACHED D1 ================= */
  REACHED_D1: {
    DISTRIBUTOR: () => ({
      title: "Vehicle Reached Hub 🏁",
      message: `Your delivery vehicle reached first checkpoint`,
    }),
  },

  /* ================= REACHED D2 ================= */
  REACHED_D2: {
    DISTRIBUTOR: () => ({
      title: "Almost There 🚚",
      message: `Your delivery vehicle reached final checkpoint`,
    }),
  },
};
