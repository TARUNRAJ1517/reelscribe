const mongoose = require("mongoose");

const GuestUsageSchema = new mongoose.Schema({
  // One-way hash of the client IP. Raw IPs are intentionally not stored.
  ipHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  previewCount: {
    type: Number,
    default: 0,
    min: 0
  }

}, { timestamps: true });

module.exports = mongoose.models.GuestUsage || mongoose.model("GuestUsage", GuestUsageSchema);
