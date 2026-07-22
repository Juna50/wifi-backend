// Converts a duration in milliseconds to RouterOS's limit-uptime time
// format ("HH:MM:SS" or "Xd HH:MM:SS" for >=1 day).
function msToRouterOSDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return days > 0
    ? `${days}d${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Human-readable label for SMS messages, e.g. "5 hours", "1 day 2 hours".
function msToLabel(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) return totalMinutes + (totalMinutes === 1 ? ' minute' : ' minutes');
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const parts = [];
  if (days > 0) parts.push(days + (days === 1 ? ' day' : ' days'));
  if (hours > 0) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
  return parts.join(' ') || '0 minutes';
}

module.exports = { msToRouterOSDuration, msToLabel };
