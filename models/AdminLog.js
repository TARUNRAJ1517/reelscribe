const mongoose = require("mongoose");

// Audit trail for admin panel actions — additive only, never read by
// anything else, so it carries no risk to existing behavior if it's ever
// slow to write (writes are fire-and-forget, never blocking the response).
const adminLogSchema = new mongoose.Schema({
  action:      { type: String, required: true },   // e.g. "add-credit", "set-plan", "login"
  targetEmail: { type: String, default: null },     // which user was affected, if any
  details:     { type: String, default: "" },       // short human-readable summary
  ip:          { type: String, default: "" },
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.model("AdminLog", adminLogSchema);
