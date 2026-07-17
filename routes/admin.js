const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const RouterStats = require('../models/RouterStats');
const RouterCommand = require('../models/RouterCommand');
const AdminUser = require('../models/AdminUser');
const ActivityLog = require('../models/ActivityLog');
const Settings = require('../models/Settings');
const { PACKAGE_PRICES_GHS, PACKAGE_DURATION_MS } = require('../packages');
const { sendBulkSms } = require('../sms');
const { auth, requireRole } = require('../authMiddleware');

const ADMIN_KEY = process.env.ADMIN_KEY;

function genRef() {
  return 'ngw_' + crypto.randomBytes(8).toString('hex');
}
function genApiKey() {
  return crypto.randomBytes(20).toString('hex');
}
function logActivity(actor, action, details) {
  ActivityLog.create({ actor, action, details }).catch(err => console.error('activity log failed:', err.message));
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
router.get('/admin/dashboard', auth, async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [todayAgg, weekAgg, pendingCount, customerCount, stats, dailyAgg, typeAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { status: 'success', canceled: false, createdAt: { $gte: startOfToday } } },
        { $group: { _id: null, revenue: { $sum: '$amountKobo' }, count: { $sum: 1 } } }
      ]),
      Transaction.aggregate([
        { $match: { status: 'success', canceled: false, createdAt: { $gte: startOfWeek } } },
        { $group: { _id: null, revenue: { $sum: '$amountKobo' }, count: { $sum: 1 } } }
      ]),
      Transaction.countDocuments({ status: 'pending', canceled: false }),
      Transaction.distinct('phone', { phone: { $ne: 'ADMIN-GENERATED' }, status: 'success' }),
      RouterStats.findOne({ key: 'latest' }),
      Transaction.aggregate([
        { $match: { status: 'success', canceled: false, createdAt: { $gte: startOfWeek } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$amountKobo' }, orders: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Transaction.aggregate([
        { $match: { status: 'success', canceled: false } },
        { $group: { _id: '$billingType', revenue: { $sum: '$amountKobo' } } }
      ])
    ]);

    // Fill in any missing days in the 7-day window with zero, so the chart
    // doesn't skip days with no sales.
    const dailyMap = {};
    dailyAgg.forEach(d => { dailyMap[d._id] = { revenueGHS: (d.revenue || 0) / 100, orders: d.orders }; });
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      last7Days.push({ date: key, revenueGHS: (dailyMap[key] && dailyMap[key].revenueGHS) || 0, orders: (dailyMap[key] && dailyMap[key].orders) || 0 });
    }

    const billingTypeBreakdown = { online: 0, cash: 0, manual: 0 };
    typeAgg.forEach(t => { if (billingTypeBreakdown[t._id] !== undefined) billingTypeBreakdown[t._id] = (t.revenue || 0) / 100; });

    res.json({
      todayRevenueGHS: ((todayAgg[0] && todayAgg[0].revenue) || 0) / 100,
      todayOrders: (todayAgg[0] && todayAgg[0].count) || 0,
      weekRevenueGHS: ((weekAgg[0] && weekAgg[0].revenue) || 0) / 100,
      weekOrders: (weekAgg[0] && weekAgg[0].count) || 0,
      pendingBills: pendingCount,
      totalCustomers: customerCount.length,
      activeNow: (stats && stats.activeCount) || 0,
      routerLastSeen: (stats && stats.reportedAt) || null,
      last7Days,
      billingTypeBreakdown
    });
  } catch (err) {
    console.error('GET /admin/dashboard failed:', err.message);
    res.status(500).json({ message: 'Could not load dashboard' });
  }
});

// ===========================================================================
// BILLING - list/filter, create manual, edit, cancel, mark paid
// ===========================================================================
router.get('/admin/billing', auth, async (req, res) => {
  try {
    const { billingType, status, limit } = req.query;
    const filter = {};
    if (billingType) filter.billingType = billingType;
    if (status) filter.status = status;
    const rows = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 100, 300));
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/billing failed:', err.message);
    res.status(500).json([]);
  }
});

router.post('/admin/billing/manual', auth, requireRole('admin', 'cashier', 'accountant'), async (req, res) => {
  try {
    const { packageId, phone, amountKobo, note } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone required' });
    const reference = genRef();
    const tx = await Transaction.create({
      reference,
      packageId: packageId || 'manual',
      phone,
      amountKobo: amountKobo || 0,
      status: 'pending',
      billingType: 'manual',
      note,
      createdBy: req.actor.username
    });
    logActivity(req.actor.username, 'billing.create_manual', { reference });
    res.json(tx);
  } catch (err) {
    console.error('POST /admin/billing/manual failed:', err.message);
    res.status(500).json({ message: 'Could not create bill' });
  }
});

router.patch('/admin/billing/:reference', auth, requireRole('admin', 'cashier'), async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Not found' });
    const { amountKobo, note, phone } = req.body;
    if (amountKobo !== undefined) tx.amountKobo = amountKobo;
    if (note !== undefined) tx.note = note;
    if (phone !== undefined) tx.phone = phone;
    await tx.save();
    logActivity(req.actor.username, 'billing.edit', { reference: tx.reference });
    res.json(tx);
  } catch (err) {
    console.error('PATCH /admin/billing failed:', err.message);
    res.status(500).json({ message: 'Could not update bill' });
  }
});

router.post('/admin/billing/:reference/mark-paid', auth, requireRole('admin', 'cashier', 'accountant'), async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Not found' });
    tx.status = 'success';
    await tx.save();
    logActivity(req.actor.username, 'billing.mark_paid', { reference: tx.reference });
    res.json(tx);
  } catch (err) {
    console.error('POST mark-paid failed:', err.message);
    res.status(500).json({ message: 'Could not mark as paid' });
  }
});

router.post('/admin/billing/:reference/cancel', auth, requireRole('admin', 'cashier'), async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Not found' });
    tx.canceled = true;
    tx.status = 'failed';
    await tx.save();
    logActivity(req.actor.username, 'billing.cancel', { reference: tx.reference });
    res.json(tx);
  } catch (err) {
    console.error('POST cancel failed:', err.message);
    res.status(500).json({ message: 'Could not cancel' });
  }
});

// ===========================================================================
// PAYMENTS - online (Paystack) vs voucher/cash, split view
// ===========================================================================
router.get('/admin/payments', auth, async (req, res) => {
  try {
    const type = req.query.type === 'voucher' ? { billingType: 'cash' } : { billingType: 'online' };
    const rows = await Transaction.find(Object.assign({}, type, { status: 'success' }))
      .sort({ createdAt: -1 })
      .limit(200);
    const totalGHS = rows.reduce((sum, t) => sum + (t.amountKobo || 0), 0) / 100;
    res.json({ rows, totalGHS });
  } catch (err) {
    console.error('GET /admin/payments failed:', err.message);
    res.status(500).json({ rows: [], totalGHS: 0 });
  }
});

// ===========================================================================
// VOUCHERS - cash-sale generation (existing), now with role/logging
// ===========================================================================
router.post('/admin/vouchers/generate', auth, requireRole('admin', 'cashier'), async (req, res) => {
  try {
    const { packageId, quantity } = req.body;
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 0, 1), 50);
    const priceGHS = PACKAGE_PRICES_GHS[packageId];
    if (!priceGHS && packageId !== 'test') {
      return res.status(400).json({ message: 'Unknown package - check spelling matches your router profile exactly' });
    }

    const creates = Array.from({ length: qty }, () => {
      const reference = genRef();
      return Transaction.create({
        reference,
        packageId,
        phone: 'ADMIN-GENERATED',
        amountKobo: (priceGHS || 0) * 100,
        status: 'success',
        billingType: 'cash',
        createdBy: req.actor.username
      }).then(tx => tx.reference);
    });
    const references = await Promise.all(creates);
    logActivity(req.actor.username, 'vouchers.generate', { packageId, quantity: qty });
    res.json({ references, priceGHS: priceGHS || 0 });
  } catch (err) {
    console.error('POST /admin/vouchers/generate failed:', err.message);
    res.status(500).json({ message: 'Could not generate vouchers' });
  }
});

// ===========================================================================
// ROUTER STATS - router pushes in, admin reads
// ===========================================================================
router.post('/router-stats', async (req, res) => {
  try {
    const key = req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) return res.sendStatus(401);
    const { activeUsers, activeCount, totalVoucherAccounts, cpuLoad, freeMemory, totalMemory, uptime } = req.body;
    await RouterStats.findOneAndUpdate(
      { key: 'latest' },
      { activeUsers: activeUsers || [], activeCount: activeCount || 0, totalVoucherAccounts: totalVoucherAccounts || 0,
        cpuLoad: cpuLoad || 0, freeMemory: freeMemory || 0, totalMemory: totalMemory || 0, uptime: uptime || '', reportedAt: new Date() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /router-stats failed:', err.message);
    res.status(500).json({ message: 'Could not store stats' });
  }
});

router.get('/admin/router-stats', auth, async (req, res) => {
  try {
    const stats = await RouterStats.findOne({ key: 'latest' });
    res.json(stats || { activeUsers: [], activeCount: 0, reportedAt: null });
  } catch (err) {
    console.error('GET /admin/router-stats failed:', err.message);
    res.status(500).json({ activeUsers: [], activeCount: 0 });
  }
});

// ===========================================================================
// CUSTOMERS & SMS
// ===========================================================================
router.get('/admin/customers', auth, async (req, res) => {
  try {
    const customers = await Transaction.aggregate([
      { $match: { phone: { $ne: 'ADMIN-GENERATED' }, status: 'success' } },
      { $group: { _id: '$phone', orderCount: { $sum: 1 }, totalSpentKobo: { $sum: '$amountKobo' }, lastOrder: { $max: '$createdAt' } } },
      { $sort: { lastOrder: -1 } }
    ]);
    res.json(customers.map(c => ({ phone: c._id, orderCount: c.orderCount, totalSpentGHS: (c.totalSpentKobo || 0) / 100, lastOrder: c.lastOrder })));
  } catch (err) {
    console.error('GET /admin/customers failed:', err.message);
    res.status(500).json([]);
  }
});

router.post('/admin/sms/bulk', auth, requireRole('admin', 'cashier'), async (req, res) => {
  try {
    const { message, phones } = req.body;
    if (!message || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ message: 'Message and at least one phone number required' });
    }
    if (phones.length > 500) return res.status(400).json({ message: 'Max 500 recipients per send - split into batches' });
    const sent = await sendBulkSms(phones, message);
    logActivity(req.actor.username, 'sms.bulk_send', { recipientCount: phones.length });
    res.json({ sent, recipientCount: phones.length });
  } catch (err) {
    console.error('POST /admin/sms/bulk failed:', err.message);
    res.status(500).json({ message: 'Could not send bulk SMS' });
  }
});

// Reminder SMS: customers whose voucher expires within the next N hours
router.get('/admin/sms/expiring-soon', auth, async (req, res) => {
  try {
    const hoursAhead = parseFloat(req.query.hours) || 2;
    const candidates = await Transaction.find({ synced: true, expired: false, phone: { $ne: 'ADMIN-GENERATED' } })
      .select('phone packageId createdAt hotspotUsername');
    const now = Date.now();
    const soon = candidates.filter(tx => {
      const durationMs = PACKAGE_DURATION_MS[tx.packageId];
      if (!durationMs) return false;
      const remainingMs = tx.createdAt.getTime() + durationMs - now;
      return remainingMs > 0 && remainingMs <= hoursAhead * 60 * 60 * 1000;
    });
    res.json(soon.map(tx => ({ phone: tx.phone, packageId: tx.packageId, hotspotUsername: tx.hotspotUsername })));
  } catch (err) {
    console.error('GET /admin/sms/expiring-soon failed:', err.message);
    res.status(500).json([]);
  }
});

// ===========================================================================
// REPORTS - CSV export
// ===========================================================================
router.get('/admin/reports/export', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = {};
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    const rows = await Transaction.find(filter).sort({ createdAt: -1 }).limit(5000);
    const header = 'reference,packageId,phone,amountGHS,status,billingType,canceled,hotspotUsername,createdAt\n';
    const csv = rows.map(t => [
      t.reference, t.packageId, t.phone, ((t.amountKobo || 0) / 100).toFixed(2),
      t.status, t.billingType, t.canceled, t.hotspotUsername || '', t.createdAt.toISOString()
    ].join(',')).join('\n');
    logActivity(req.actor.username, 'reports.export', { rowCount: rows.length });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="netghwifi-report.csv"');
    res.send(header + csv);
  } catch (err) {
    console.error('GET /admin/reports/export failed:', err.message);
    res.status(500).send('Could not generate report');
  }
});

// ===========================================================================
// ACTIVITY LOGS
// ===========================================================================
router.get('/admin/activity-logs', auth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await ActivityLog.find({}).sort({ createdAt: -1 }).limit(200);
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/activity-logs failed:', err.message);
    res.status(500).json([]);
  }
});

// ===========================================================================
// USER / ROLE MANAGEMENT (admin only)
// ===========================================================================
router.get('/admin/users', auth, requireRole('admin'), async (req, res) => {
  try {
    const users = await AdminUser.find({}).select('username role active createdAt').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error('GET /admin/users failed:', err.message);
    res.status(500).json([]);
  }
});

router.post('/admin/users', auth, requireRole('admin'), async (req, res) => {
  try {
    const { username, role } = req.body;
    if (!username || ['admin', 'cashier', 'accountant'].indexOf(role) === -1) {
      return res.status(400).json({ message: 'Username and a valid role (admin/cashier/accountant) required' });
    }
    const apiKey = genApiKey();
    const user = await AdminUser.create({ username, role, apiKey });
    logActivity(req.actor.username, 'users.create', { username, role });
    res.json({ username: user.username, role: user.role, apiKey });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'Username already exists' });
    console.error('POST /admin/users failed:', err.message);
    res.status(500).json({ message: 'Could not create user' });
  }
});

router.post('/admin/users/:username/deactivate', auth, requireRole('admin'), async (req, res) => {
  try {
    const user = await AdminUser.findOneAndUpdate({ username: req.params.username }, { active: false }, { new: true });
    if (!user) return res.status(404).json({ message: 'Not found' });
    logActivity(req.actor.username, 'users.deactivate', { username: user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST deactivate failed:', err.message);
    res.status(500).json({ message: 'Could not deactivate user' });
  }
});

// ===========================================================================
// SETTINGS
// ===========================================================================
router.get('/admin/settings', auth, async (req, res) => {
  try {
    const rows = await Settings.find({});
    const obj = {};
    rows.forEach(function (r) { obj[r.key] = r.value; });
    res.json(obj);
  } catch (err) {
    console.error('GET /admin/settings failed:', err.message);
    res.status(500).json({});
  }
});

router.patch('/admin/settings', auth, requireRole('admin'), async (req, res) => {
  try {
    const updates = req.body || {};
    const keys = Object.keys(updates);
    for (let i = 0; i < keys.length; i++) {
      await Settings.findOneAndUpdate({ key: keys[i] }, { value: updates[keys[i]] }, { upsert: true });
    }
    logActivity(req.actor.username, 'settings.update', { keys: keys });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /admin/settings failed:', err.message);
    res.status(500).json({ message: 'Could not save settings' });
  }
});

// ===========================================================================
// LEGACY - kept so anything still calling the old endpoint works unchanged
// ===========================================================================
router.get('/admin/transactions', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const txs = await Transaction.find({}).sort({ createdAt: -1 }).limit(limit)
      .select('reference packageId phone amountKobo status hotspotUsername synced smsSent expired billingType canceled createdAt');
    res.json(txs);
  } catch (err) {
    console.error('GET /admin/transactions failed:', err.message);
    res.status(500).json([]);
  }
});

// ===========================================================================
// TERMINAL - remote action runner (admin only). This is NOT a full
// interactive console: RouterOS scripting has no reliable way to capture
// arbitrary console print output back into a string, so this reports
// success/fail only. For anything you need to *see*, use Monitoring - it's
// already reporting real data. Full failure detail always lives in the
// router's own /log.
// ===========================================================================
router.post('/admin/terminal/execute', auth, requireRole('admin'), async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || !command.trim()) return res.status(400).json({ message: 'Command required' });
    const cmd = await RouterCommand.create({ command: command.trim(), requestedBy: req.actor.username });
    logActivity(req.actor.username, 'terminal.execute', { command: command.trim() });
    res.json({ id: cmd._id });
  } catch (err) {
    console.error('POST /admin/terminal/execute failed:', err.message);
    res.status(500).json({ message: 'Could not queue command' });
  }
});

router.get('/admin/terminal/history', auth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await RouterCommand.find({}).sort({ createdAt: -1 }).limit(50);
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/terminal/history failed:', err.message);
    res.status(500).json([]);
  }
});

// Router polls this - key-protected the same way as /router-stats, not
// the per-user auth system, since the router itself has no "user".
router.get('/terminal/next', async (req, res) => {
  try {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(401);
    const cmd = await RouterCommand.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'claimed' } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!cmd) return res.json({ found: false });
    res.json({ found: true, id: cmd._id, command: cmd.command });
  } catch (err) {
    console.error('GET /terminal/next failed:', err.message);
    res.status(500).json({ found: false });
  }
});

router.post('/terminal/:id/result', async (req, res) => {
  try {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(401);
    const { status } = req.body;
    await RouterCommand.findByIdAndUpdate(req.params.id, {
      status: status === 'error' ? 'error' : 'done',
      completedAt: new Date()
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /terminal/:id/result failed:', err.message);
    res.status(500).json({ message: 'Could not store result' });
  }
});

module.exports = router;
