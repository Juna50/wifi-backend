const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const { sendSms } = require('../sms');
const { msToRouterOSDuration, msToLabel } = require('../durationFormat');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

function genRef() {
  return 'ngw_' + crypto.randomBytes(8).toString('hex');
}

// --- Public site config, used by login.html --------------------------------
// Lets the backend control maintenance mode, the ad banner, and the
// announcement banner without editing/redeploying the static portal page.
// Deliberately only exposes these few keys (not the full Settings
// collection) since this endpoint is unauthenticated and hit by every
// captive-portal page load.
const SITE_CONFIG_DEFAULTS = {
  maintenanceMode: false,
  maintenanceMessage: "We're down for maintenance right now. Please check back shortly.",
  adBannerEnabled: true,
  announcementEnabled: true,
  announcementMessages: [
    '\uD83D\uDCCD For Enquires WhatsApp: 0545837116',
    '\uD83D\uDCB8 Buy Normal Data, Airtime, Waec Checker & More',
    '\u26A1 Fast delivery \u2022 Secure payments \u2022 24/7 support'
  ]
};
const SITE_CONFIG_KEYS = Object.keys(SITE_CONFIG_DEFAULTS);

router.get('/site-config', async (req, res) => {
  try {
    const rows = await Settings.find({ key: { $in: SITE_CONFIG_KEYS.concat(['adBannerSlides']) } });
    const config = Object.assign({}, SITE_CONFIG_DEFAULTS, { adBannerSlides: [] });
    rows.forEach(function (r) {
      if (r.key === 'adBannerSlides') {
        const slides = Array.isArray(r.value) ? r.value : [];
        // Only send the lightweight bits (id/link/alt) - the actual image
        // bytes are fetched separately per-slide via /ad-banner/:id/image so
        // browsers can cache each one instead of re-downloading base64 with
        // every single site-config call.
        config.adBannerSlides = slides
          .slice()
          .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); })
          .map(function (s) { return { id: s.id, link: s.link || '', alt: s.alt || 'Ad' }; });
        return;
      }
      if (r.value !== undefined && r.value !== null) config[r.key] = r.value;
    });
    res.json(config);
  } catch (err) {
    console.error('GET /site-config failed:', err.message);
    // Fail open with safe defaults - a portal page should never be stuck
    // unable to render just because this lookup had a hiccup.
    res.json(Object.assign({}, SITE_CONFIG_DEFAULTS, { adBannerSlides: [] }));
  }
});

// Serves one uploaded ad banner image by id. Public (no auth) and cacheable
// since it's just an image the portal page shows to everyone anyway.
router.get('/ad-banner/:id/image', async (req, res) => {
  try {
    const row = await Settings.findOne({ key: 'adBannerSlides' });
    const slides = Array.isArray(row && row.value) ? row.value : [];
    const slide = slides.find(function (s) { return s.id === req.params.id; });
    if (!slide || !slide.imageBase64) return res.status(404).send('Not found');
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(slide.imageBase64);
    if (!match) return res.status(415).send('Unsupported image format');
    res.set('Content-Type', match[1]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(match[2], 'base64'));
  } catch (err) {
    console.error('GET /ad-banner/:id/image failed:', err.message);
    res.status(500).send('Error');
  }
});

async function notifyVoucherReady(tx) {
  if (tx.smsSent) return;
  const product = await Product.findOne({ productId: tx.packageId });
  const hours = product ? msToLabel(product.durationMs) : '';
  const message = `NETGHWiFi\nCode: ${tx.hotspotUsername} (use as Username & Password)\nValid: ${hours}\nConnect to NETGHWiFi WiFi, then open:\nhttp://netgh.wifi/status\nEnjoy!`;
  const sent = await sendSms(tx.phone, message);
  if (sent) {
    tx.smsSent = true;
    await tx.save();
  }
}

// --- Public product catalog, used by login.html ---------------------------
// Lightweight on purpose - no image data - since the captive portal loads
// this on every single connection through the walled garden. Full product
// data (with images) is at /admin/products for the panel.
router.get('/products', async (req, res) => {
  try {
    const products = await Product.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .select('productId name category price durationMs isTrial dataAmount speed badge features type');
    res.json(products);
  } catch (err) {
    console.error('GET /products failed:', err.message);
    res.status(500).json([]);
  }
});

// --- 1. Create an order --------------------------------------------------
router.post('/orders', async (req, res) => {
  try {
    const { profile, phone, mac, ip } = req.body;
    const product = await Product.findOne({ productId: profile, active: true });
    if (!product || !phone) {
      return res.status(400).json({ message: 'Invalid package or missing phone' });
    }

    const reference = genRef();
    const tx = await Transaction.create({
      reference,
      packageId: profile,
      phone,
      amountKobo: product.price * 100,
      status: 'pending'
    });

    res.json({ reference: tx.reference, amountKobo: tx.amountKobo });
  } catch (err) {
    console.error('POST /orders failed:', err.message);
    res.status(500).json({ message: 'Could not create order' });
  }
});

// --- 2. Client says "I paid" -> we independently verify with Paystack ---
router.post('/orders/:reference/confirm', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Unknown reference' });
    if (tx.status === 'success') return res.json({ status: 'success' });

    try {
      const verifyRes = await fetch(
        `https://api.paystack.co/transaction/verify/${tx.reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      );
      const verifyData = await verifyRes.json();

      if (verifyData?.data?.status === 'success' &&
        verifyData.data.amount === tx.amountKobo) {
        tx.status = 'success';
        await tx.save();
      } else if (verifyData?.data?.status === 'failed') {
        tx.status = 'failed';
        await tx.save();
      }
      // if still "abandoned"/"pending" on Paystack's side, leave tx.status as pending and let the client keep polling
    } catch (err) {
      console.error('Paystack verify failed:', err.message);
    }

    res.json({ status: tx.status });
  } catch (err) {
    console.error('POST /orders/:reference/confirm failed:', err.message);
    res.status(500).json({ message: 'Could not confirm order' });
  }
});

// --- 3. Client polls for its own voucher ---------------------------------
router.get('/orders/:reference/status', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ status: 'unknown' });

    if (tx.synced && tx.hotspotUsername) {
      return res.json({
        status: 'success',
        hotspotUsername: tx.hotspotUsername,
        hotspotPassword: tx.hotspotPassword
      });
    }
    res.json({ status: tx.status === 'failed' ? 'failed' : 'pending' });
  } catch (err) {
    console.error('GET /orders/:reference/status failed:', err.message);
    res.status(500).json({ status: 'error' });
  }
});

// --- 4. Paystack webhook (belt-and-suspenders alongside /confirm) -------
router.post('/webhooks/paystack', async (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.sendStatus(401);

    const event = req.body;
    if (event.event === 'charge.success') {
      const tx = await Transaction.findOne({ reference: event.data.reference });
      if (tx && tx.status !== 'success') {
        tx.status = 'success';
        await tx.save();
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('POST /webhooks/paystack failed:', err.message);
    res.sendStatus(500);
  }
});

// --- 5. Free trial, one per phone/MAC ------------------------------------
router.post('/orders/trial', async (req, res) => {
  try {
    const { phone, mac } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number required' });

    const existing = await Transaction.findOne({
      packageId: 'test',
      $or: [{ phone }, { hotspotUsername: mac }]
    });
    if (existing) {
      return res.status(200).json({ message: 'Trial already used on this device.' });
    }

    const reference = genRef();
    const tx = await Transaction.create({
      reference,
      packageId: 'test',
      phone,
      amountKobo: 0,
      status: 'success' // trials skip payment entirely
    });
    res.json({ reference: tx.reference });
  } catch (err) {
    console.error('POST /orders/trial failed:', err.message);
    res.status(500).json({ message: 'Could not start trial' });
  }
});

// --- 6. Router polling script: fetch work queue --------------------------
router.get('/pending', async (req, res) => {
  try {
    const pending = await Transaction.find({ status: 'success', dispatched: false })
      .select('reference packageId phone')
      .limit(50);
    res.json(pending);
  } catch (err) {
    console.error('GET /pending failed:', err.message);
    res.status(500).json([]);
  }
});

// --- 6b. Router polling script: claim ONE order at a time ----------------
// RouterOS scripting can't easily walk a JSON array, so this atomically
// hands back a single pending order (flat fields, easy to string-parse)
// and immediately marks it dispatched so a second poll never double-claims
// the same order. If two people place orders in the same poll interval,
// the router just calls this again right after.
router.post('/orders/claim-next', async (req, res) => {
  try {
    const tx = await Transaction.findOneAndUpdate(
      { status: 'success', dispatched: false },
      { $set: { dispatched: true, dispatchedAt: new Date() } },
      { new: true }
    );
    if (!tx) return res.json({ found: false });

    const product = await Product.findOne({ productId: tx.packageId });
    const uptimeLimit = product ? msToRouterOSDuration(product.durationMs) : '05:00:00'; // safe fallback if a product was deleted after being sold

    res.json({ found: true, reference: tx.reference, packageId: tx.packageId, phone: tx.phone, uptimeLimit });
  } catch (err) {
    console.error('POST /orders/claim-next failed:', err.message);
    res.status(500).json({ found: false });
  }
});

// --- 7. Router polling script: report a hotspot user was created ---------
router.post('/orders/:reference/dispatched', async (req, res) => {
  try {
    const { hotspotUsername, hotspotPassword } = req.body;
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Unknown reference' });

    tx.dispatched = true;
    tx.dispatchedAt = new Date();
    tx.synced = true;
    tx.hotspotUsername = hotspotUsername;
    tx.hotspotPassword = hotspotPassword;
    await tx.save();

    notifyVoucherReady(tx).catch(err => console.error('SMS notify failed:', err.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /orders/:reference/dispatched failed:', err.message);
    res.status(500).json({ message: 'Could not mark dispatched' });
  }
});

// --- 8. Voucher recovery: resend the most recent voucher by phone --------
router.post('/vouchers/recover', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number required' });

    const tx = await Transaction.findOne({ phone, hotspotUsername: { $ne: null } })
      .sort({ createdAt: -1 });

    if (tx && tx.hotspotUsername) {
      const product = await Product.findOne({ productId: tx.packageId });
      const hours = product ? msToLabel(product.durationMs) : '';
      const message = `NETGHWiFi\nRecovered Code: ${tx.hotspotUsername} (use as Username & Password)\nValid: ${hours}\nConnect to NETGHWiFi WiFi, then open:\nhttp://netgh.wifi/status\nKeep it safe!`;
      await sendSms(phone, message).catch(err => console.error('recover SMS failed:', err.message));
    }

    // Same response whether or not anything was found - don't let someone
    // use this to probe which phone numbers have bought vouchers.
    res.json({ message: "If we have a voucher on file for this number, we've just sent it by SMS." });
  } catch (err) {
    console.error('POST /vouchers/recover failed:', err.message);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
});

// --- 9. Calendar expiry sweep: what's past its validity window ----------
router.get('/orders/expired', async (req, res) => {
  try {
    const now = Date.now();
    const candidates = await Transaction.find({
      synced: true,
      expired: false,
      hotspotUsername: { $ne: null }
    }).select('reference hotspotUsername packageId createdAt');

    const products = await Product.find({}).select('productId durationMs');
    const durationMap = {};
    products.forEach(p => { durationMap[p.productId] = p.durationMs; });

    const toExpire = candidates
      .filter(tx => {
        const durationMs = durationMap[tx.packageId];
        if (!durationMs) return false;
        return (now - tx.createdAt.getTime()) > durationMs;
      })
      .map(tx => ({ reference: tx.reference, hotspotUsername: tx.hotspotUsername }));

    res.json(toExpire);
  } catch (err) {
    console.error('GET /orders/expired failed:', err.message);
    res.status(500).json([]);
  }
});

// --- 10. Router confirms it disabled an expired voucher -------------------
router.post('/orders/:reference/expired', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference });
    if (!tx) return res.status(404).json({ message: 'Unknown reference' });
    tx.expired = true;
    await tx.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /orders/:reference/expired failed:', err.message);
    res.status(500).json({ message: 'Could not mark expired' });
  }
});

module.exports = router;
