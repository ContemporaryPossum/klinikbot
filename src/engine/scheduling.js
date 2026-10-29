// Date/time helpers in the clinic's timezone and slot availability.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad(n) { return String(n).padStart(2, '0'); }

// Returns {y,m,d,hh,mm,dow,dateStr,timeStr} for an instant in a timezone.
function localParts(instant, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hh = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh, mm: Number(parts.minute), dow,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`, timeStr: `${pad(hh)}:${parts.minute}`,
  };
}

// Offset (minutes) of tz at a given instant.
function tzOffsetMinutes(instant, tz) {
  const p = localParts(instant, tz);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asUTC - instant.getTime()) / 60000);
}

// Build an instant from a local date + time string in tz.
function toInstant(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - off * 60000);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fromMinutes(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

function todayStr(clinic, nowInstant = new Date()) { return localParts(nowInstant, clinic.timezone).dateStr; }

function isOpen(clinic, dateStr) {
  const h = clinic.hours[DAY_KEYS[dowOf(dateStr)]];
  return Array.isArray(h) && h.length === 2;
}

// All slots for a date (ignoring bookings).
function rawSlots(clinic, dateStr) {
  const h = clinic.hours[DAY_KEYS[dowOf(dateStr)]];
  if (!h) return [];
  const [open, close] = h.map(toMinutes);
  const lunch = clinic.lunch ? clinic.lunch.map(toMinutes) : null;
  const out = [];
  for (let t = open; t + clinic.slot_minutes <= close; t += clinic.slot_minutes) {
    if (lunch && t >= lunch[0] && t < lunch[1]) continue;
    out.push(fromMinutes(t));
  }
  return out;
}

// Available slots for a date & service duration, given existing bookings and the current time.
function availableSlots(clinic, dateStr, durationMin, bookings, nowInstant = new Date()) {
  const slots = rawSlots(clinic, dateStr);
  if (!slots.length) return [];
  const h = clinic.hours[DAY_KEYS[dowOf(dateStr)]];
  const close = toMinutes(h[1]);
  const lunch = clinic.lunch ? clinic.lunch.map(toMinutes) : null;
  const busy = bookings.filter(b => b.date === dateStr && b.status === 'confirmed')
    .map(b => [toMinutes(b.time), toMinutes(b.time) + b.duration]);
  const nowP = localParts(nowInstant, clinic.timezone);
  const minStart = nowP.dateStr === dateStr ? toMinutes(nowP.timeStr) + (clinic.min_lead_minutes || 0) : -1;
  return slots.filter(s => {
    const st = toMinutes(s), en = st + durationMin;
    if (en > close) return false;
    if (lunch && st < lunch[1] && en > lunch[0]) return false;
    if (st < minStart) return false;
    return !busy.some(([bs, be]) => st < be && en > bs);
  });
}

// Next N open dates from (and including) a start date.
function nextOpenDates(clinic, fromDateStr, n) {
  const out = [];
  let d = fromDateStr;
  for (let i = 0; i < (clinic.max_days_ahead || 14) && out.length < n; i++) {
    if (isOpen(clinic, d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

function withinBookingWindow(clinic, dateStr, nowInstant = new Date()) {
  const t = todayStr(clinic, nowInstant);
  return dateStr >= t && dateStr <= addDays(t, clinic.max_days_ahead || 14);
}

function startOfWeek(dateStr) { // Monday
  const dow = dowOf(dateStr);
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}

module.exports = {
  DAY_KEYS, localParts, toInstant, addDays, dowOf, toMinutes, fromMinutes, todayStr, isOpen,
  rawSlots, availableSlots, nextOpenDates, withinBookingWindow, startOfWeek, pad,
};
