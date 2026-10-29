// SQLite storage using Node 22's built-in node:sqlite — no npm dependencies.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'klinikbot.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  clinic_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  lang TEXT,
  step TEXT NOT NULL DEFAULT 'idle',
  data TEXT NOT NULL DEFAULT '{}',
  name TEXT,
  handoff_until INTEGER,
  last_reminder_booking_id INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (clinic_id, phone)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,          -- YYYY-MM-DD (clinic local)
  time TEXT NOT NULL,          -- HH:MM (clinic local)
  duration INTEGER NOT NULL,   -- minutes
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled | completed | no_show
  patient_confirmed INTEGER NOT NULL DEFAULT 0,
  reminders_sent TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'whatsapp',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_clinic_date ON bookings (clinic_id, date, time);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings (clinic_id, phone);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,     -- in | out
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (clinic_id, phone, created_at);
`);

const now = () => Date.now();

// ---- conversations ----
const getConvStmt = db.prepare('SELECT * FROM conversations WHERE clinic_id = ? AND phone = ?');
const upsertConvStmt = db.prepare(`
  INSERT INTO conversations (clinic_id, phone, lang, step, data, name, handoff_until, last_reminder_booking_id, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(clinic_id, phone) DO UPDATE SET
    lang = excluded.lang, step = excluded.step, data = excluded.data, name = excluded.name,
    handoff_until = excluded.handoff_until, last_reminder_booking_id = excluded.last_reminder_booking_id,
    updated_at = excluded.updated_at
`);

function getConversation(clinicId, phone) {
  const row = getConvStmt.get(clinicId, phone);
  if (!row) return { clinic_id: clinicId, phone, lang: null, step: 'idle', data: {}, name: null, handoff_until: null, last_reminder_booking_id: null };
  return { ...row, data: JSON.parse(row.data || '{}') };
}

function saveConversation(c) {
  upsertConvStmt.run(c.clinic_id, c.phone, c.lang, c.step, JSON.stringify(c.data || {}), c.name || null,
    c.handoff_until || null, c.last_reminder_booking_id || null, now());
}

// ---- bookings ----
const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (clinic_id, phone, name, service_id, date, time, duration, status, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
`);
const bookingsOnDateStmt = db.prepare(`SELECT * FROM bookings WHERE clinic_id = ? AND date = ? AND status = 'confirmed'`);
const upcomingForPhoneStmt = db.prepare(`
  SELECT * FROM bookings WHERE clinic_id = ? AND phone = ? AND status = 'confirmed' AND (date > ? OR (date = ? AND time >= ?))
  ORDER BY date, time LIMIT 5
`);
const getBookingStmt = db.prepare('SELECT * FROM bookings WHERE id = ?');
const updateBookingStmt = db.prepare(`
  UPDATE bookings SET name = ?, service_id = ?, date = ?, time = ?, duration = ?, status = ?, patient_confirmed = ?, reminders_sent = ?, updated_at = ?
  WHERE id = ?
`);
const allUpcomingStmt = db.prepare(`SELECT * FROM bookings WHERE clinic_id = ? AND status = 'confirmed' AND date >= ? ORDER BY date, time`);
const listBookingsStmt = db.prepare(`SELECT * FROM bookings WHERE clinic_id = ? ORDER BY date DESC, time DESC LIMIT ?`);
const lastNameForPhoneStmt = db.prepare(`SELECT name FROM bookings WHERE clinic_id = ? AND phone = ? AND name IS NOT NULL ORDER BY created_at DESC LIMIT 1`);

function createBooking(b) {
  const t = now();
  const res = insertBookingStmt.run(b.clinic_id, b.phone, b.name || null, b.service_id, b.date, b.time, b.duration, b.source || 'whatsapp', t, t);
  return getBooking(Number(res.lastInsertRowid));
}
function getBooking(id) {
  const row = getBookingStmt.get(id);
  return row ? { ...row, reminders_sent: JSON.parse(row.reminders_sent || '[]') } : null;
}
function updateBooking(b) {
  updateBookingStmt.run(b.name || null, b.service_id, b.date, b.time, b.duration, b.status, b.patient_confirmed ? 1 : 0,
    JSON.stringify(b.reminders_sent || []), now(), b.id);
  return getBooking(b.id);
}
function bookingsOnDate(clinicId, date) { return bookingsOnDateStmt.all(clinicId, date); }
function upcomingForPhone(clinicId, phone, todayStr, nowHHMM) { return upcomingForPhoneStmt.all(clinicId, phone, todayStr, todayStr, nowHHMM).map(r => ({ ...r, reminders_sent: JSON.parse(r.reminders_sent || '[]') })); }
function allUpcoming(clinicId, todayStr) { return allUpcomingStmt.all(clinicId, todayStr).map(r => ({ ...r, reminders_sent: JSON.parse(r.reminders_sent || '[]') })); }
function listBookings(clinicId, limit = 50) { return listBookingsStmt.all(clinicId, limit).map(r => ({ ...r, reminders_sent: JSON.parse(r.reminders_sent || '[]') })); }
function lastNameForPhone(clinicId, phone) { const r = lastNameForPhoneStmt.get(clinicId, phone); return r ? r.name : null; }

// ---- messages ----
const insertMsgStmt = db.prepare('INSERT INTO messages (clinic_id, phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?)');
const recentMsgsStmt = db.prepare('SELECT * FROM messages WHERE clinic_id = ? AND phone = ? ORDER BY created_at DESC LIMIT ?');
function logMessage(clinicId, phone, direction, text) { insertMsgStmt.run(clinicId, phone, direction, text, now()); }
function recentMessages(clinicId, phone, limit = 50) { return recentMsgsStmt.all(clinicId, phone, limit).reverse(); }

// ---- demo helpers ----
function resetPhone(clinicId, phone) {
  db.prepare('DELETE FROM conversations WHERE clinic_id = ? AND phone = ?').run(clinicId, phone);
  db.prepare('DELETE FROM bookings WHERE clinic_id = ? AND phone = ?').run(clinicId, phone);
  db.prepare('DELETE FROM messages WHERE clinic_id = ? AND phone = ?').run(clinicId, phone);
}
function stats(clinicId, todayStr, weekStartStr) {
  const q = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    today: q(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND date = ? AND status = 'confirmed'`, clinicId, todayStr),
    this_week: q(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND date >= ? AND status = 'confirmed'`, clinicId, weekStartStr),
    confirmed_by_patient: q(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND status = 'confirmed' AND patient_confirmed = 1`, clinicId),
    total: q(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ?`, clinicId),
  };
}

module.exports = {
  db, DB_PATH,
  getConversation, saveConversation,
  createBooking, getBooking, updateBooking, bookingsOnDate, upcomingForPhone, allUpcoming, listBookings, lastNameForPhone,
  logMessage, recentMessages,
  resetPhone, stats,
};
