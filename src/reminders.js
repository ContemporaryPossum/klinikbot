// Reminder scheduler: checks every minute and sends the 24h / 2h reminders via the active channel.
const db = require('./store');
const S = require('./engine/scheduling');
const { buildReminder } = require('./engine/conversation');

// deliver(phone, message) is channel-specific (WhatsApp or demo).
function start(clinic, deliver, { intervalMs = 60000, log = console } = {}) {
  const tick = () => runOnce(clinic, deliver, log).catch(e => log.error('[reminders]', e.message));
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// A reminder that fails to send (template not approved yet, account blocked, network) is retried, but not every
// minute: 10 minutes between attempts per booking+reminder, and never more than 12 attempts. One failure never
// stops the other bookings' reminders.
const RETRY_MS = 10 * 60000, MAX_ATTEMPTS = 12;
const failures = new Map(); // `${booking.id}:${hours}` -> { at, attempts, error }

async function runOnce(clinic, deliver, log = console, nowInstant = new Date()) {
  const today = S.todayStr(clinic, nowInstant);
  const hoursList = (clinic.reminders && clinic.reminders.hours_before) || [24, 2];
  const sent = [], failed = [];
  for (const b of db.allUpcoming(clinic.id, today)) {
    const start = S.toInstant(b.date, b.time, clinic.timezone);
    const msUntil = start.getTime() - nowInstant.getTime();
    if (msUntil <= 0) continue;
    for (const h of hoursList) {
      if (b.reminders_sent.includes(h)) continue;
      if (msUntil > h * 3600000) continue;
      const key = `${b.id}:${h}`;
      const f = failures.get(key);
      if (f && (f.attempts >= MAX_ATTEMPTS || nowInstant.getTime() - f.at < RETRY_MS)) continue;
      try {
        await sendReminder(clinic, b, h, deliver, log);
        failures.delete(key);
        sent.push({ booking_id: b.id, hours: h });
      } catch (e) {
        const attempts = (f ? f.attempts : 0) + 1;
        failures.set(key, { at: nowInstant.getTime(), attempts, error: e.message });
        failed.push({ booking_id: b.id, hours: h, attempts, error: e.message });
        log.error && log.error(`[reminders] ${h}h reminder for booking #${b.id} failed (attempt ${attempts}): ${e.message}`);
      }
    }
  }
  return failed.length ? Object.assign(sent, { failed }) : sent;
}

async function sendReminder(clinic, booking, hours, deliver, log = console) {
  const msg = buildReminder(clinic, booking, hours);
  await deliver(booking.phone, msg);
  booking.reminders_sent = [...new Set([...booking.reminders_sent, hours])];
  db.updateBooking(booking);
  log.info && log.info(`[reminders] sent ${hours}h reminder for booking #${booking.id} to ${booking.phone}`);
  return msg;
}

module.exports = { start, runOnce, sendReminder, _failures: failures };
