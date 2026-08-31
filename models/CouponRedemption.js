const mongoose = require('mongoose');

const CouponRedemptionSchema = new mongoose.Schema({
  code: { type: String, required: true, index: true, uppercase: true },
  email: { type: String, required: true, index: true, lowercase: true, trim: true },
  plan: { type: String, required: true },
  orderId: { type: String, required: true, unique: true, index: true },
  paymentId: { type: String, required: true },
  discount: { type: Number, required: true, min: 0 },
  originalAmount: { type: Number, required: true, min: 0 },
  finalAmount: { type: Number, required: true, min: 0 },
}, { timestamps: true });

module.exports = mongoose.models.CouponRedemption || mongoose.model('CouponRedemption', CouponRedemptionSchema);
