// SMS alert helper — mNotify (Quick SMS)
// Docs: https://readthedocs.mnotify.com/
require('dotenv').config();

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY;
const MNOTIFY_SENDER_ID = process.env.MNOTIFY_SENDER_ID || 'NETGHWiFi'; // must be <=11 chars and registered with mNotify

/**
 * mNotify's quick-SMS endpoint expects local Ghana numbers (0XXXXXXXXXX),
 * not E.164. Transaction.phone is stored as E.164 (+233...), so convert.
 */
function toLocalGhana(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\s+/g, '');
  if (digits.startsWith('+233')) return '0' + digits.slice(4);
  if (digits.startsWith('233')) return '0' + digits.slice(3);
  return digits; // already local format, pass through unchanged
}

/**
 * Sends an SMS via mNotify. `to` can be E.164 (+233...) or local (0...).
 */
async function sendSms(to, message) {
  if (!to) {
    console.warn('sendSms skipped: no phone number provided');
    return false;
  }
  if (!MNOTIFY_API_KEY) {
    console.error('sendSms skipped: MNOTIFY_API_KEY is not set');
    return false;
  }

  try {
    const res = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: [toLocalGhana(to)],
        sender: MNOTIFY_SENDER_ID,
        message,
        is_schedule: false,
        schedule_date: ''
        // sms_type: "otp" — leave out entirely; it's billed extra and this isn't OTP traffic
      })
    });

    const data = await res.json();

    if (!res.ok || data.status !== 'success') {
      console.error('mNotify send failed:', JSON.stringify(data));
      return false;
    }

    console.log('SMS sent via mNotify:', JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('SMS send failed:', err.message);
    return false;
  }
}

/**
 * Sends one SMS to many recipients in a single mNotify call (promotional
 * blasts). mNotify's recipient array already supports multiple numbers -
 * this is the same endpoint as sendSms, just with more than one entry.
 */
async function sendBulkSms(toList, message) {
  if (!Array.isArray(toList) || toList.length === 0) {
    console.warn('sendBulkSms skipped: no recipients provided');
    return false;
  }
  if (!MNOTIFY_API_KEY) {
    console.error('sendBulkSms skipped: MNOTIFY_API_KEY is not set');
    return false;
  }

  try {
    const res = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: toList.map(toLocalGhana),
        sender: MNOTIFY_SENDER_ID,
        message,
        is_schedule: false,
        schedule_date: ''
      })
    });

    const data = await res.json();

    if (!res.ok || data.status !== 'success') {
      console.error('mNotify bulk send failed:', JSON.stringify(data));
      return false;
    }

    console.log('Bulk SMS sent via mNotify:', JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('Bulk SMS send failed:', err.message);
    return false;
  }
}

module.exports = { sendSms, sendBulkSms };
