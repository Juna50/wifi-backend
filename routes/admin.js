const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const RouterStats = require('../models/RouterStats');
const RouterCommand = require('../models/RouterCommand');
const AdminUser = require('../models/AdminUser');
const ActivityLog = require('../models/ActivityLog');
const Settings = require('../models/Settings');
const Product = require('../models/Product');
const { msToRouterOSDuration } = require('../durationFormat');
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
    const product = await Product.findOne({ productId: packageId, active: true });
    if (!product) {
      return res.status(400).json({ message: 'Unknown or inactive package - check the Products tab' });
    }
    const priceGHS = product.price;

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

    const existing = await RouterStats.findOne({ key: 'latest' });
    const history = existing ? existing.history || [] : [];
    history.push({ timestamp: new Date(), activeCount: activeCount || 0, cpuLoad: cpuLoad || 0 });
    while (history.length > 30) history.shift();

    await RouterStats.findOneAndUpdate(
      { key: 'latest' },
      { activeUsers: activeUsers || [], activeCount: activeCount || 0, totalVoucherAccounts: totalVoucherAccounts || 0,
        cpuLoad: cpuLoad || 0, freeMemory: freeMemory || 0, totalMemory: totalMemory || 0, uptime: uptime || '', reportedAt: new Date(),
        history },
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
    const products = await Product.find({}).select('productId durationMs');
    const durationMap = {};
    products.forEach(p => { durationMap[p.productId] = p.durationMs; });
    const now = Date.now();
    const soon = candidates.filter(tx => {
      const durationMs = durationMap[tx.packageId];
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
    if (req.params.username === req.actor.username) {
      return res.status(400).json({ message: "You can't deactivate your own account." });
    }
    const user = await AdminUser.findOneAndUpdate({ username: req.params.username }, { active: false }, { new: true });
    if (!user) return res.status(404).json({ message: 'Not found' });
    logActivity(req.actor.username, 'users.deactivate', { username: user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST deactivate failed:', err.message);
    res.status(500).json({ message: 'Could not deactivate user' });
  }
});

// "Extend" restores access for a deactivated account (the counterpart to
// Deactivate above) - same account, same API key, just re-enabled.
router.post('/admin/users/:username/extend', auth, requireRole('admin'), async (req, res) => {
  try {
    const user = await AdminUser.findOneAndUpdate({ username: req.params.username }, { active: true }, { new: true });
    if (!user) return res.status(404).json({ message: 'Not found' });
    logActivity(req.actor.username, 'users.extend', { username: user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST extend failed:', err.message);
    res.status(500).json({ message: 'Could not extend user' });
  }
});

router.delete('/admin/users/:username', auth, requireRole('admin'), async (req, res) => {
  try {
    if (req.params.username === req.actor.username) {
      return res.status(400).json({ message: "You can't delete your own account." });
    }
    const target = await AdminUser.findOne({ username: req.params.username });
    if (!target) return res.status(404).json({ message: 'Not found' });
    if (target.role === 'admin') {
      const otherActiveAdmins = await AdminUser.countDocuments({ role: 'admin', active: true, username: { $ne: target.username } });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ message: 'Cannot delete the last active admin account.' });
      }
    }
    await AdminUser.deleteOne({ username: req.params.username });
    logActivity(req.actor.username, 'users.delete', { username: req.params.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/users failed:', err.message);
    res.status(500).json({ message: 'Could not delete user' });
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
// AD BANNER — images uploaded here are what the login page's ad slideshow
// shows. Stored as base64 (same pattern as product images) in the generic
// Settings store under the key 'adBannerSlides'. The public image bytes are
// served separately, via GET /api/ad-banner/:id/image in orders.js, so this
// endpoint only ever returns/accepts lightweight metadata plus one image at
// a time - never the whole gallery's base64 in one response.
// ===========================================================================
const AD_BANNER_MAX_SLIDES = 8;
const AD_BANNER_MAX_IMAGE_LEN = 700000; // ~500KB after base64 overhead - same cap as product images

router.get('/admin/ad-banner', auth, async (req, res) => {
  try {
    const row = await Settings.findOne({ key: 'adBannerSlides' });
    const slides = Array.isArray(row && row.value) ? row.value : [];
    res.json(slides
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map(s => ({ id: s.id, link: s.link, alt: s.alt, sortOrder: s.sortOrder })));
  } catch (err) {
    console.error('GET /admin/ad-banner failed:', err.message);
    res.status(500).json([]);
  }
});

router.post('/admin/ad-banner', auth, requireRole('admin'), async (req, res) => {
  try {
    const { imageBase64, link, alt } = req.body;
    if (!imageBase64) return res.status(400).json({ message: 'imageBase64 is required' });
    if (imageBase64.length > AD_BANNER_MAX_IMAGE_LEN) {
      return res.status(400).json({ message: 'Image too large - please use a smaller file (under ~500KB)' });
    }
    const row = await Settings.findOne({ key: 'adBannerSlides' });
    const slides = Array.isArray(row && row.value) ? row.value : [];
    if (slides.length >= AD_BANNER_MAX_SLIDES) {
      return res.status(400).json({ message: `Max ${AD_BANNER_MAX_SLIDES} banner images - delete one before adding another` });
    }
    const slide = {
      id: crypto.randomBytes(8).toString('hex'),
      imageBase64,
      link: link || '',
      alt: alt || 'Ad',
      sortOrder: slides.length
    };
    slides.push(slide);
    await Settings.findOneAndUpdate({ key: 'adBannerSlides' }, { value: slides }, { upsert: true });
    logActivity(req.actor.username, 'ad_banner.upload', { id: slide.id });
    res.json({ id: slide.id, link: slide.link, alt: slide.alt, sortOrder: slide.sortOrder });
  } catch (err) {
    console.error('POST /admin/ad-banner failed:', err.message);
    res.status(500).json({ message: 'Could not save image' });
  }
});

router.patch('/admin/ad-banner/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { link, alt, sortOrder } = req.body;
    const row = await Settings.findOne({ key: 'adBannerSlides' });
    const slides = Array.isArray(row && row.value) ? row.value : [];
    const slide = slides.find(s => s.id === req.params.id);
    if (!slide) return res.status(404).json({ message: 'Not found' });
    if (link !== undefined) slide.link = link;
    if (alt !== undefined) slide.alt = alt;
    if (sortOrder !== undefined) slide.sortOrder = sortOrder;
    await Settings.findOneAndUpdate({ key: 'adBannerSlides' }, { value: slides });
    logActivity(req.actor.username, 'ad_banner.edit', { id: slide.id });
    res.json({ id: slide.id, link: slide.link, alt: slide.alt, sortOrder: slide.sortOrder });
  } catch (err) {
    console.error('PATCH /admin/ad-banner failed:', err.message);
    res.status(500).json({ message: 'Could not update' });
  }
});

router.delete('/admin/ad-banner/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const row = await Settings.findOne({ key: 'adBannerSlides' });
    const slides = Array.isArray(row && row.value) ? row.value : [];
    const next = slides.filter(s => s.id !== req.params.id);
    if (next.length === slides.length) return res.status(404).json({ message: 'Not found' });
    await Settings.findOneAndUpdate({ key: 'adBannerSlides' }, { value: next });
    logActivity(req.actor.username, 'ad_banner.delete', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/ad-banner failed:', err.message);
    res.status(500).json({ message: 'Could not delete' });
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

// ===========================================================================
// PRODUCTS - the editable package catalog. This replaces the old static
// packages.js/router-hardcoded-map approach that caused repeated drift bugs.
//
// IMPORTANT: productId here still has to match a real RouterOS hotspot user
// profile name for vouchers to actually work. Creating a product here does
// NOT create that on its own - but it DOES auto-queue a Terminal command to
// create it, via the existing remote command system, closing most of that
// gap automatically. Confirm it actually ran (check Terminal history) before
// relying on a brand new product.
// ===========================================================================
function sanitizeForRouterOS(str) {
  return String(str).replace(/["\\]/g, ''); // strip quotes/backslashes - this gets embedded in a RouterOS command string
}

router.get('/admin/products', auth, async (req, res) => {
  try {
    const products = await Product.find({}).sort({ sortOrder: 1, createdAt: 1 });
    res.json(products);
  } catch (err) {
    console.error('GET /admin/products failed:', err.message);
    res.status(500).json([]);
  }
});

router.post('/admin/products', auth, requireRole('admin'), async (req, res) => {
  try {
    const { productId, name, category, price, durationMs, rateLimit, imageBase64, isTrial, dataAmount, speed, badge, features, type } = req.body;
    if (!productId || !name || !durationMs) {
      return res.status(400).json({ message: 'productId, name, and durationMs are required' });
    }
    if (imageBase64 && imageBase64.length > 700000) { // ~500KB after base64 overhead
      return res.status(400).json({ message: 'Image too large - please use a smaller file (under ~500KB)' });
    }

    const product = await Product.create({
      productId, name, category: category || 'General',
      price: price || 0, durationMs, rateLimit: rateLimit || '5M/5M',
      imageBase64, isTrial: !!isTrial,
      dataAmount: dataAmount || 'Time-based', speed: speed || '15 Mbps',
      badge: badge || undefined, features: Array.isArray(features) ? features : [],
      type: type || 'limited'
    });

    // Auto-queue the matching hotspot profile creation on the router.
    const safeId = sanitizeForRouterOS(productId);
    const safeRate = sanitizeForRouterOS(rateLimit || '5M/5M');
    const uptimeStr = msToRouterOSDuration(durationMs);
    const command = `/ip hotspot user profile add name="${safeId}" address-pool="NETGHWiFi Hotspot Pool" session-timeout=${uptimeStr} rate-limit="${safeRate}"`;
    await RouterCommand.create({ command, requestedBy: req.actor.username });

    logActivity(req.actor.username, 'products.create', { productId });
    res.json({ product, message: 'Product created. A command to create the matching router profile has been queued - check Terminal history in ~10s to confirm it ran.' });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A product with that productId already exists' });
    console.error('POST /admin/products failed:', err.message);
    res.status(500).json({ message: 'Could not create product' });
  }
});

router.patch('/admin/products/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { name, category, price, durationMs, rateLimit, imageBase64, active, sortOrder, dataAmount, speed, badge, features, type } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Not found' });

    if (name !== undefined) product.name = name;
    if (category !== undefined) product.category = category;
    if (price !== undefined) product.price = price;
    if (durationMs !== undefined) product.durationMs = durationMs;
    if (rateLimit !== undefined) product.rateLimit = rateLimit;
    if (imageBase64 !== undefined) {
      if (imageBase64 && imageBase64.length > 700000) return res.status(400).json({ message: 'Image too large' });
      product.imageBase64 = imageBase64;
    }
    if (active !== undefined) product.active = active;
    if (sortOrder !== undefined) product.sortOrder = sortOrder;
    if (dataAmount !== undefined) product.dataAmount = dataAmount;
    if (speed !== undefined) product.speed = speed;
    if (badge !== undefined) product.badge = badge;
    if (features !== undefined) product.features = Array.isArray(features) ? features : [];
    if (type !== undefined) product.type = type;

    await product.save();
    logActivity(req.actor.username, 'products.edit', { productId: product.productId });
    res.json(product);
  } catch (err) {
    console.error('PATCH /admin/products failed:', err.message);
    res.status(500).json({ message: 'Could not update product' });
  }
});

router.post('/admin/products/:id/deactivate', auth, requireRole('admin'), async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
    if (!product) return res.status(404).json({ message: 'Not found' });
    logActivity(req.actor.username, 'products.deactivate', { productId: product.productId });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST deactivate product failed:', err.message);
    res.status(500).json({ message: 'Could not deactivate' });
  }
});

router.post('/admin/products/seed-defaults', auth, requireRole('admin'), async (req, res) => {
  try {
    const existingCount = await Product.countDocuments({});
    if (existingCount > 0) {
      return res.status(400).json({ message: 'Products already exist - seed only runs on an empty collection, to avoid duplicating or overwriting real data.' });
    }
    const defaults = [
      { productId: '5 Hours', name: '5 Hours', dataAmount: 'Time-based', durationMs: 5 * 60 * 60 * 1000, speed: '15 Mbps', price: 5, type: 'limited', features: ['1 Device'], sortOrder: 0 },
      { productId: '12 Hours', name: '12 Hours', dataAmount: 'Time-based', durationMs: 12 * 60 * 60 * 1000, speed: '15 Mbps', price: 8, type: 'limited', features: ['1 Device'], sortOrder: 1 },
      { productId: '1 Day Falaaa', name: '1 Day Falaaa', dataAmount: '5 GB', durationMs: 24 * 60 * 60 * 1000, speed: '15 Mbps', price: 12, type: 'limited', badge: 'SPECIAL OFFER', features: ['8K Streaming', 'Video Calls', 'Super Fast Download', '1 Device'], sortOrder: 2 },
      { productId: '2 Days Turbo Max', name: '2 Days Turbo Max', dataAmount: '20 GB', durationMs: 48 * 60 * 60 * 1000, speed: '15 Mbps', price: 15, type: 'limited', badge: 'SPECIAL OFFER', features: ['4K Streaming', 'Video Calls', 'Fast Download', '1 Device'], sortOrder: 3 },
      { productId: '1Hr Unlimited', name: '1Hr Unlimited', dataAmount: 'Unlimited', durationMs: 60 * 60 * 1000, speed: '15 Mbps', price: 3, type: 'unlimited', badge: 'UNLIMITED', features: ['HD Streaming', 'Video Calls', 'Fast Download', '1 Device'], sortOrder: 4 },
      { productId: '24Hr Unlimited', name: '24Hr Unlimited', dataAmount: 'Unlimited', durationMs: 24 * 60 * 60 * 1000, speed: '15 Mbps', price: 10, type: 'unlimited', badge: 'UNLIMITED', features: ['HD Streaming', 'Video Calls', 'Fast Download', '1 Device'], sortOrder: 5 },
      { productId: 'test', name: '5 Min Trial', dataAmount: 'Limited', durationMs: 5 * 60 * 1000, speed: '15 Mbps', price: 0, type: 'trial', badge: 'FREE', features: [], isTrial: true, sortOrder: 6 }
    ];
    await Product.insertMany(defaults);
    logActivity(req.actor.username, 'products.seed_defaults', { count: defaults.length });
    res.json({ message: 'Seeded ' + defaults.length + ' default products.', count: defaults.length });
  } catch (err) {
    console.error('POST /admin/products/seed-defaults failed:', err.message);
    res.status(500).json({ message: 'Could not seed products' });
  }
});

module.exports = router;
