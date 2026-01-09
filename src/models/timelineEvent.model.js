const mongoose = require("mongoose");

const TimelineEventSchema = new mongoose.Schema({
  slotId: { type: String, required: true },
  orderId: { type: String }, 

  distributorName: { type: String },
  orderAmount: { type: Number },

  thresholdAmount: { type: Number },
  isAboveThreshold: { type: Boolean },

  eventType: {
    type: String,
    enum: [
      "ORDER_CREATED",
      "ORDER_CONFIRMED",
      "SLOT_BOOKED",
      "SLOT_BOOKING_COMPLETED",

      "VEHICLE_SELECTED",

      "LOADING_STARTED",
      "LOADING_ITEM",
      "LOADING_COMPLETED",

      "DRIVER_ASSIGNED",
      "DRIVE_STARTED",

      "REACHED_DROP",
      "UNLOADING_STARTED",
      "UNLOADING_COMPLETED",

      "WAREHOUSE_REACHED"
    ],
    required: true
  },

  eventLabel: { type: String },

  // To store vehicleNo, driverName, dropName etc
  meta: { type: Object, default: {} },

  performedByRole: { type: String }, 
  performedById: { type: String },
  performedByName: { type: String },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("timeline_events", TimelineEventSchema);
