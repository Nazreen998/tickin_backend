const mongoose = require("mongoose");

const SlotSchema = new mongoose.Schema({
  slotId: { type: String, unique: true },
  session: String,
  time: String,

  status: {
    type: String,
    enum: ["AVAILABLE", "PENDING", "CONFIRMED"],
    default: "AVAILABLE"
  },

  locationId: Number,

  bookedOrders: [String], // orderIds
  bookedDistributors: [
    {
      orderId: String,
      distributorName: String
    }
  ],

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("slots", SlotSchema);
