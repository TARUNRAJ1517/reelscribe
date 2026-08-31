const mongoose = require("mongoose");

// One row per successful (or failed/refunded) Razorpay payment.
// Written from /verify-payment once a payment is confirmed — this is what
// the admin Revenue tab reads from, since Razorpay's own dashboard isn't
// queried live.
const PaymentSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  plan: { type: String, enum: ["starter", "pro", "agency"], required: true },
  billingCycle: { type: String, enum: ["monthly", "yearly"], required: true },
  amount: { type: Number, required: true }, // in rupees (INR), not paise
  status: { type: String, enum: ["paid", "failed", "refunded"], default: "paid" },
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model("Payment", PaymentSchema);
