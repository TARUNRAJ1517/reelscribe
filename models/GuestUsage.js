const mongoose = require("mongoose");

const GuestUsageSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true
  },

  previewCount: {
    type: Number,
    default: 0
  }

}, {
  timestamps: true
});

module.exports = mongoose.model("GuestUsage", GuestUsageSchema);
