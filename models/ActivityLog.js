const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  actor: String,       // username, or "system"
  action: String,       // e.g. "voucher.generate", "billing.cancel"
  details: Object,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ActivityLog', activityLogSchema);
