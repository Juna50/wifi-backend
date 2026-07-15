const AdminUser = require('./models/AdminUser');

const SUPER_ADMIN_KEY = process.env.ADMIN_KEY;

// Attaches req.actor ({ username, role }) on success. 'admin' role from the
// legacy env key always has full access - kept as a permanent fallback so
// a broken AdminUser collection can never lock you out entirely.
async function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey || (req.body && req.body.adminKey);
  if (!key) return res.status(401).json({ message: 'Missing admin key' });

  if (SUPER_ADMIN_KEY && key === SUPER_ADMIN_KEY) {
    req.actor = { username: 'super-admin', role: 'admin' };
    return next();
  }

  try {
    const user = await AdminUser.findOne({ apiKey: key, active: true });
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.actor = { username: user.username, role: user.role };
    next();
  } catch (err) {
    console.error('auth lookup failed:', err.message);
    res.status(500).json({ message: 'Auth check failed' });
  }
}

// Usage: requireRole('admin'), requireRole('admin', 'cashier'), etc.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.actor || !roles.includes(req.actor.role)) {
      return res.status(403).json({ message: 'Not permitted for your role' });
    }
    next();
  };
}

module.exports = { auth, requireRole };
