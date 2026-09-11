const mongoose = require("mongoose");

const SubscriptionSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  plan: { type: String, enum: ["starter", "pro", "agency"], required: true },

  razorpaySubscriptionId: { type: String, required: true, unique: true, index: true },
  razorpayPlanId:         { type: String, required: true },

  // Mirrors Razorpay's subscription lifecycle states.
  status: {
    type: String,
    enum: ["created", "authenticated", "active", "pending", "halted", "cancelled", "completed", "expired"],
    default: "created",
    index: true,
  },

  trialChargeAmount: { type: Number, default: 0, min: 0 },   // the ₹1 (in rupees) intro charge
  fullAmount:         { type: Number, required: true, min: 0 }, // real recurring amount, e.g. 299
  currentStart: { type: Date, default: null },
  currentEnd:   { type: Date, default: null },
  chargeAt:     { type: Date, default: null },

  paidCount:  { type: Number, default: 0, min: 0 },
  lastPaymentId: { type: String, default: null },

  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.Subscription || mongoose.model("Subscription", SubscriptionSchema);
