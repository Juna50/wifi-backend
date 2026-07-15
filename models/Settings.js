const mongoose = require('mongoose');

// Simple key-value store. NOTE: package pricing/duration still lives in
// packages.js (backend) and hardcoded maps in the router scripts - making
// those live-editable from here would require the router scripts to also
// fetch config dynamically, which is a separate, coordinated change.
// This is for things purely on the backend/panel side, like SMS wording.
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed
});

module.exports = mongoose.model('Settings', settingsSchema);
