const mongoose = require('mongoose');

const routerCommandSchema = new mongoose.Schema({
  command: { type: String, required: true },
  status: { type: String, enum: ['pending', 'claimed', 'done', 'error'], default: 'pending' },
  requestedBy: String,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

module.exports = mongoose.model('RouterCommand', routerCommandSchema);
