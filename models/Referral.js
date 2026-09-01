const mongoose = require("mongoose");

const ReferralSchema = new mongoose.Schema({
  referrerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  referredEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  referralCode:  { type: String, required: true, uppercase: true, trim: true },
  status: { type: String, enum: ["pending", "credited"], default: "pending", index: true },
  creditedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.models.Referral || mongoose.model("Referral", ReferralSchema);
