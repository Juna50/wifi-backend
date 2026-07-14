const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const { PACKAGE_PRICES_GHS } = require('../packages');

const ADMIN_KEY = process.env.ADMIN_KEY;

function checkAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey || (req.body && req.body.adminKey);
  if (!ADMIN_KEY) {
    return res.status(500).json({ message: 'ADMIN_KEY is not set on the server - set it in Render env vars first' });
  }
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

function genRef() {
  return 'ngw_' + crypto.randomBytes(8).toString('hex');
}

// --- Generate offline/cash-sale vouchers ----------------------------------
// These skip payment entirely (status is created as 'success' directly) and
// flow through your EXISTING router fulfillment script automatically -
// no separate router integration needed. Use this for vouchers you sell in
// person for cash, or want pre-printed to hand out.
router.post('/admin/vouchers/generate', checkAdmin, async (req, res) => {
  try {
    const { packageId, quantity } = req.body;
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 0, 1), 50); // capped per batch
    const priceGHS = PACKAGE_PRICES_GHS[packageId];
    if (!priceGHS && packageId !== 'test') {
      return res.status(400).json({ message: 'Unknown package - check spelling matches your router profile exactly' });
    }

    const references = [];
    for (let i = 0; i < qty; i++) {
      const reference = genRef();
      await Transaction.create({
        reference,
        packageId,
        phone: 'ADMIN-GENERATED',
        amountKobo: (priceGHS || 0) * 100,
        status: 'success' // this record itself IS the cash-sale log
      });
      references.push(reference);
    }
    res.json({ references });
  } catch (err) {
    console.error('POST /admin/vouchers/generate failed:', err.message);
    res.status(500).json({ message: 'Could not generate vouchers' });
  }
});

// --- Recent transactions, for basic monitoring ----------------------------
router.get('/admin/transactions', checkAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const txs = await Transaction.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('reference packageId phone amountKobo status hotspotUsername synced smsSent expired createdAt');
    res.json(txs);
  } catch (err) {
    console.error('GET /admin/transactions failed:', err.message);
    res.status(500).json([]);
  }
});

module.exports = router;
