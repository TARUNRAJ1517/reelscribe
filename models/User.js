const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },

  name: {
    type: String,
    required: true
  },

  credits: {
    type: Number,
    default: 10
  },

  // ── PLAN FIELDS ──
  plan: {
    type: String,
    enum: ["free", "starter", "pro", "agency"],
    default: "free"
  },

  planExpiresAt: {
    type: Date,
    default: null
  },

  // Clip usage tracking
  clipsUsedToday: {
    type: Number,
    default: 0
  },

  clipsUsedMonth: {
    type: Number,
    default: 0
  },

  lastClipDate: {
    type: Date,
    default: null
  },

  // Transcript usage tracking
  transcriptsUsedMonth: {
    type: Number,
    default: 0
  },

  lastTranscriptResetDate: {
    type: Date,
    default: null
  }

}, {
  timestamps: true
});

module.exports = mongoose.model("User", UserSchema);
