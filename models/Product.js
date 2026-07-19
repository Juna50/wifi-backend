const mongoose = require('mongoose');

// Single source of truth for hotspot packages. productId MUST exactly match
// a hotspot user profile name that actually exists on the router - creating
// a product here does NOT create it there. See routes/admin.js for the
// auto-queued Terminal command that handles that half automatically.
const productSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, default: 'General' },
  price: { type: Number, required: true }, // GHS
  durationMs: { type: Number, required: true },
  rateLimit: { type: String, default: '5M/5M' }, // RouterOS rate-limit format
  imageBase64: String,
  isTrial: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },

  // Display/marketing fields matching what the portal's package cards show
  dataAmount: { type: String, default: 'Time-based' }, // e.g. "5 GB", "Unlimited", "Time-based"
  speed: { type: String, default: '15 Mbps' },
  badge: String, // e.g. "SPECIAL OFFER", "UNLIMITED" - blank for none
  features: [String],
  type: { type: String, enum: ['limited', 'unlimited', 'trial'], default: 'limited' },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Product', productSchema);
