// Single source of truth for package pricing/duration/labels on the backend.
// IMPORTANT: keys must exactly match your router's hotspot user profile
// names (spaces/capitalization included), and match login.html's
// PACKAGES array `profile` values. Update all three together.

const PACKAGE_PRICES_GHS = {
  '5 Hours': 5,
  '12 Hours': 8,
  '1 Day Falaaa': 12,
  '2 Days Turbo Max': 15,
  '1Hr Unlimited': 3,
  '24Hr Unlimited': 10
};

const PACKAGE_DURATION_MS = {
  test: 5 * 60 * 1000,
  '5 Hours': 5 * 60 * 60 * 1000,
  '12 Hours': 12 * 60 * 60 * 1000,
  '1 Day Falaaa': 24 * 60 * 60 * 1000,
  '2 Days Turbo Max': 48 * 60 * 60 * 1000,
  '1Hr Unlimited': 1 * 60 * 60 * 1000,
  '24Hr Unlimited': 24 * 60 * 60 * 1000
};

const PACKAGE_HOURS_LABEL = {
  test: '5 minutes',
  '5 Hours': '5 hours',
  '12 Hours': '12 hours',
  '1 Day Falaaa': '1 day',
  '2 Days Turbo Max': '2 days',
  '1Hr Unlimited': '1 hour',
  '24Hr Unlimited': '24 hours'
};

module.exports = { PACKAGE_PRICES_GHS, PACKAGE_DURATION_MS, PACKAGE_HOURS_LABEL };
