const mongoose = require("mongoose");

const TimelineEventSchema = new mongoose.Schema({
  slotId: { type: String, required: true },
  orderId: { type: String }, // nullable for slot-level events

  distributorName: { type: String },
  orderAmount: { type: Number },

  eventType: {
    type: String,
    enum: [
      "VEHICLE_SELECTED",
      "LOADING_STARTED",
      "LOADING_ITEM",
      "LOADING_COMPLETED",
      "DRIVER_ASSIGNED"
    ],
    required: true
  },

  eventLabel: { type: String },
  performedByRole: { type: String }, // MANAGER / SALESMAN
  performedById: { type: String },
  performedByName: { type: String },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("timeline_events", TimelineEventSchema);
