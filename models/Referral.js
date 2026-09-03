const mongoose = require("mongoose");

const ReferralSchema = new mongoose.Schema({
  referrerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  referredEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  referralCode:  { type: String, required: true, uppercase: true, trim: true },
  status: { type: String, enum: ["pending", "pending_review", "credited", "rejected"], default: "pending", index: true },
  creditedAt: { type: Date, default: null },
  referredIpHash: { type: String, default: null, index: true },
  referredUaHash: { type: String, default: null },
  referrerIpHash: { type: String, default: null },
  referrerUaHash: { type: String, default: null },
  riskReason: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.Referral || mongoose.model("Referral", ReferralSchema);
