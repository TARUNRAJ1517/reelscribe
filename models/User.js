const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name:  { type: String, required: true },
  credits: { type: Number, default: 10 },

  // ── PLAN ──
  plan: {
    type: String,
    enum: ["free", "starter", "pro", "agency"],
    default: "free"
  },
  planExpiresAt: { type: Date, default: null },

  // ── TRANSCRIPTION TRACKING ──
  transcriptsUsedToday:     { type: Number, default: 0 },
  transcriptsUsedMonth:     { type: Number, default: 0 },
  lastTranscriptDate:       { type: Date,   default: null },
  lastTranscriptResetDate:  { type: Date,   default: null },

  // ── CLIP TRACKING ──
  clipsUsedToday:   { type: Number, default: 0 },
  clipsUsedMonth:   { type: Number, default: 0 },
  lastClipDate:     { type: Date,   default: null },

}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);
