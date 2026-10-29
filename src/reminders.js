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

async function runOnce(clinic, deliver, log = console, nowInstant = new Date()) {
  const today = S.todayStr(clinic, nowInstant);
  const hoursList = (clinic.reminders && clinic.reminders.hours_before) || [24, 2];
  const sent = [];
  for (const b of db.allUpcoming(clinic.id, today)) {
    const start = S.toInstant(b.date, b.time, clinic.timezone);
    const msUntil = start.getTime() - nowInstant.getTime();
    if (msUntil <= 0) continue;
    for (const h of hoursList) {
      if (b.reminders_sent.includes(h)) continue;
      if (msUntil > h * 3600000) continue;
      // Skip the shorter reminder if the longer one was never sent and would be due at the same moment (booking made last-minute)
      await sendReminder(clinic, b, h, deliver, log);
      sent.push({ booking_id: b.id, hours: h });
    }
  }
  return sent;
}

async function sendReminder(clinic, booking, hours, deliver, log = console) {
  const msg = buildReminder(clinic, booking, hours);
  await deliver(booking.phone, msg);
  booking.reminders_sent = [...new Set([...booking.reminders_sent, hours])];
  db.updateBooking(booking);
  log.info && log.info(`[reminders] sent ${hours}h reminder for booking #${booking.id} to ${booking.phone}`);
  return msg;
}

module.exports = { start, runOnce, sendReminder };
