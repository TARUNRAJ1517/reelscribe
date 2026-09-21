const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Canonical identity used to stop Gmail dot/plus alias abuse.
  emailIdentity: { type: String, index: true, sparse: true },
  name:  { type: String, required: true },
  credits: { type: Number, default: 5, min: 0 },
  creditsUsedTotal: { type: Number, default: 0, min: 0 },

  plan: {
    type: String,
    enum: ["free", "starter", "pro", "agency"],
    default: "free"
  },
  planExpiresAt: { type: Date, default: null },
  // Last paid plan is preserved after expiry/downgrade for accurate win-back analytics.
  lastPaidPlan: { type: String, enum: ["starter", "pro", "agency", null], default: null },
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

  // Referral program: one verified first-transcript referral earns one
  // Starter-equivalent clip cut for the referrer.
  referralCode:   { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  referredBy:     { type: String, default: null, uppercase: true, trim: true },
  referralCuts:   { type: Number, default: 0, min: 0 },
  referralsCount: { type: Number, default: 0, min: 0 },

  // One-way request fingerprints used for referral anti-abuse checks.
  signupIpHash: { type: String, default: null, index: true },
  signupUaHash: { type: String, default: null },
  lastSeenIpHash: { type: String, default: null },
  lastSeenUaHash: { type: String, default: null },

}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
