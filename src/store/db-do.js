// Store backed by a Cloudflare Durable Object's SQLite (ctx.storage.sql) — synchronous, same interface as db.js.
// `sql.exec(query, ...params)` returns a cursor with .toArray() / .one(); we only rely on .toArray().
function createStore(sql) {
  const q = (query, ...params) => sql.exec(query, ...params).toArray();
  const get = (query, ...params) => q(query, ...params)[0] || null;
  const now = () => Date.now();

  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS conversations (clinic_id TEXT NOT NULL, phone TEXT NOT NULL, lang TEXT, step TEXT NOT NULL DEFAULT 'idle', data TEXT NOT NULL DEFAULT '{}', name TEXT, handoff_until INTEGER, last_reminder_booking_id INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (clinic_id, phone))`,
    `CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id TEXT NOT NULL, phone TEXT NOT NULL, name TEXT, service_id TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', patient_confirmed INTEGER NOT NULL DEFAULT 0, reminders_sent TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'whatsapp', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_clinic_date ON bookings (clinic_id, date, time)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings (clinic_id, phone)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id TEXT NOT NULL, phone TEXT NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (clinic_id, phone, created_at)`,
  ]) sql.exec(stmt);

  const rowB = r => r ? { ...r, reminders_sent: JSON.parse(r.reminders_sent || '[]') } : null;

  return {
    DB_PATH: 'durable-object-sqlite',
    getConversation(clinicId, phone) {
      const row = get('SELECT * FROM conversations WHERE clinic_id = ? AND phone = ?', clinicId, phone);
      if (!row) return { clinic_id: clinicId, phone, lang: null, step: 'idle', data: {}, name: null, handoff_until: null, last_reminder_booking_id: null };
      return { ...row, data: JSON.parse(row.data || '{}') };
    },
    saveConversation(c) {
      sql.exec(`INSERT INTO conversations (clinic_id, phone, lang, step, data, name, handoff_until, last_reminder_booking_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(clinic_id, phone) DO UPDATE SET lang = excluded.lang, step = excluded.step, data = excluded.data, name = excluded.name, handoff_until = excluded.handoff_until, last_reminder_booking_id = excluded.last_reminder_booking_id, updated_at = excluded.updated_at`,
        c.clinic_id, c.phone, c.lang, c.step, JSON.stringify(c.data || {}), c.name || null, c.handoff_until || null, c.last_reminder_booking_id || null, now());
    },
    createBooking(b) {
      const t = now();
      const row = get(`INSERT INTO bookings (clinic_id, phone, name, service_id, date, time, duration, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?) RETURNING *`,
        b.clinic_id, b.phone, b.name || null, b.service_id, b.date, b.time, b.duration, b.source || 'whatsapp', t, t);
      return rowB(row);
    },
    getBooking(id) { return rowB(get('SELECT * FROM bookings WHERE id = ?', Number(id))); },
    updateBooking(b) {
      sql.exec('UPDATE bookings SET name = ?, service_id = ?, date = ?, time = ?, duration = ?, status = ?, patient_confirmed = ?, reminders_sent = ?, updated_at = ? WHERE id = ?',
        b.name || null, b.service_id, b.date, b.time, b.duration, b.status, b.patient_confirmed ? 1 : 0, JSON.stringify(b.reminders_sent || []), now(), b.id);
      return this.getBooking(b.id);
    },
    bookingsOnDate(clinicId, date) { return q(`SELECT * FROM bookings WHERE clinic_id = ? AND date = ? AND status = 'confirmed'`, clinicId, date); },
    upcomingForPhone(clinicId, phone, todayStr, nowHHMM) {
      return q(`SELECT * FROM bookings WHERE clinic_id = ? AND phone = ? AND status = 'confirmed' AND (date > ? OR (date = ? AND time >= ?)) ORDER BY date, time LIMIT 5`, clinicId, phone, todayStr, todayStr, nowHHMM).map(rowB);
    },
    allUpcoming(clinicId, todayStr) { return q(`SELECT * FROM bookings WHERE clinic_id = ? AND status = 'confirmed' AND date >= ? ORDER BY date, time`, clinicId, todayStr).map(rowB); },
    listBookings(clinicId, limit = 50) { return q('SELECT * FROM bookings WHERE clinic_id = ? ORDER BY date DESC, time DESC LIMIT ?', clinicId, limit).map(rowB); },
    lastNameForPhone(clinicId, phone) { const r = get('SELECT name FROM bookings WHERE clinic_id = ? AND phone = ? AND name IS NOT NULL ORDER BY created_at DESC LIMIT 1', clinicId, phone); return r ? r.name : null; },
    logMessage(clinicId, phone, direction, text) { sql.exec('INSERT INTO messages (clinic_id, phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?)', clinicId, phone, direction, text, now()); },
    recentMessages(clinicId, phone, limit = 50) { return q('SELECT * FROM messages WHERE clinic_id = ? AND phone = ? ORDER BY created_at DESC LIMIT ?', clinicId, phone, limit).reverse(); },
    resetPhone(clinicId, phone) {
      sql.exec('DELETE FROM conversations WHERE clinic_id = ? AND phone = ?', clinicId, phone);
      sql.exec('DELETE FROM bookings WHERE clinic_id = ? AND phone = ?', clinicId, phone);
      sql.exec('DELETE FROM messages WHERE clinic_id = ? AND phone = ?', clinicId, phone);
    },
    stats(clinicId, todayStr, weekStartStr) {
      const n = (query, ...p) => get(query, ...p).n;
      return {
        today: n(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND date = ? AND status = 'confirmed'`, clinicId, todayStr),
        this_week: n(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND date >= ? AND status = 'confirmed'`, clinicId, weekStartStr),
        confirmed_by_patient: n(`SELECT COUNT(*) n FROM bookings WHERE clinic_id = ? AND status = 'confirmed' AND patient_confirmed = 1`, clinicId),
        total: n('SELECT COUNT(*) n FROM bookings WHERE clinic_id = ?', clinicId),
      };
    },
  };
}
module.exports = { createStore };
