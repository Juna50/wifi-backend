const mongoose = require('mongoose');

// Single-document collection - router overwrites the same snapshot each
// time it reports in, rather than accumulating a history.
const routerStatsSchema = new mongoose.Schema({
  key: { type: String, default: 'latest', unique: true },
  activeUsers: [{ user: String, uptime: String, address: String }],
  activeCount: Number,
  totalVoucherAccounts: Number,
  cpuLoad: Number,
  freeMemory: Number,
  totalMemory: Number,
  uptime: String,
  reportedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('RouterStats', routerStatsSchema);
