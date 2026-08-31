const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:  { type: String, required: true },
  credits: { type: Number, default: 5, min: 0 },
  creditsUsedTotal: { type: Number, default: 0, min: 0 },

  plan: {
    type: String,
    enum: ["free", "starter", "pro", "agency"],
    default: "free"
  },
  planExpiresAt: { type: Date, default: null },
  billingCycle: {
    type: String,
    enum: ["monthly", "yearly", "manual", null],
    default: null
  },

  isSuspended: { type: Boolean, default: false, index: true },
  lastActiveAt: { type: Date, default: null },

  transcriptsUsedToday:     { type: Number, default: 0, min: 0 },
  transcriptsUsedMonth:     { type: Number, default: 0, min: 0 },
  lastTranscriptDate:       { type: Date, default: null },
  lastTranscriptResetDate:  { type: Date, default: null },

  clipsUsedToday:   { type: Number, default: 0, min: 0 },
  clipsUsedMonth:   { type: Number, default: 0, min: 0 },
  lastClipDate:     { type: Date, default: null },

}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
