const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  plan: { type: String, enum: ["starter", "pro", "agency"], required: true },
  billingCycle: { type: String, enum: ["monthly", "yearly"], required: true },
  amount: { type: Number, required: true, min: 0 },
  originalAmount: { type: Number, default: null, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  couponCode: { type: String, default: null, uppercase: true, trim: true },
  status: { type: String, enum: ["paid", "failed", "refunded"], default: "paid", index: true },
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  razorpayPaymentId: { type: String, required: true, index: true },
}, { timestamps: true });

module.exports = mongoose.models.Payment || mongoose.model("Payment", PaymentSchema);
