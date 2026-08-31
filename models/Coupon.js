const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true, uppercase: true, trim: true },
  discountPercent: { type: Number, required: true, min: 1, max: 100 },
  appliesToPlans: { type: [String], enum: ['all', 'starter', 'pro', 'agency'], default: ['all'] },
  expiresAt: { type: Date, required: true },
  maxUses: { type: Number, min: 0, default: 0 },
  usedBy: { type: [String], default: [] },
  usedCount: { type: Number, min: 0, default: 0 },
  singleUsePerUser: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

CouponSchema.pre('validate', function(next) {
  this.code = String(this.code || '').trim().toUpperCase();
  if (!Array.isArray(this.appliesToPlans) || this.appliesToPlans.length === 0) this.appliesToPlans = ['all'];
  next();
});

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', CouponSchema);
