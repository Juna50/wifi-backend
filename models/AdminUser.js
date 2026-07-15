const mongoose = require('mongoose');

// Lightweight auth: each admin user gets a random API key instead of a
// password. Simpler and safer to get right on a first pass than rolling
// bcrypt/JWT for a small internal tool - no password to leak, no session
// expiry logic to get wrong. Roles gate which parts of the panel a key
// can use.
const adminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  apiKey: { type: String, required: true, unique: true },
  role: { type: String, enum: ['admin', 'cashier', 'accountant'], default: 'cashier' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminUser', adminUserSchema);
