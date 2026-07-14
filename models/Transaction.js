const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  packageId: { type: String }, // 'test' | '5hr' | '12hr' | '1day'
  email: String,
  phone: String,                 // E.164 format, e.g. +233XXXXXXXXX — used for SMS alert
  amountKobo: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  hotspotUsername: String,
  hotspotPassword: String,

  // --- fields for the router polling queue ---
  dispatched: { type: Boolean, default: false },   // router has been handed this once
  dispatchedAt: Date,                              // when it was handed out (for retry timeout)
  synced: { type: Boolean, default: false },       // router confirmed the hotspot user was created

  smsSent: { type: Boolean, default: false },

  // Calendar expiry (NOT cumulative connected time - a "1Hr Unlimited"
  // voucher should stop working 1 hour after purchase, whether or not
  // it was actually used during that window).
  expired: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
