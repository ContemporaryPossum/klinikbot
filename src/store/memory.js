// In-memory store with the same interface as db.js. Used by the standalone browser demo.
// Persists to localStorage when available (per viewer, best effort).
const KEY = 'klinikbot_demo_v1';
let state = { conversations: {}, bookings: [], messages: [], nextId: 1 };

function load() { try { const raw = globalThis.localStorage && localStorage.getItem(KEY); if (raw) state = JSON.parse(raw); } catch (e) { /* ignore */ } }
function persist() { try { globalThis.localStorage && localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
load();
const now = () => Date.now();
const ck = (c, p) => `${c}|${p}`;
const clone = o => JSON.parse(JSON.stringify(o));

function getConversation(clinicId, phone) {
  const c = state.conversations[ck(clinicId, phone)];
  return c ? clone(c) : { clinic_id: clinicId, phone, lang: null, step: 'idle', data: {}, name: null, handoff_until: null, last_reminder_booking_id: null };
}
function saveConversation(c) { state.conversations[ck(c.clinic_id, c.phone)] = clone({ ...c, updated_at: now() }); persist(); }

function createBooking(b) {
  const t = now();
  const row = { id: state.nextId++, clinic_id: b.clinic_id, phone: b.phone, name: b.name || null, service_id: b.service_id, date: b.date, time: b.time, duration: b.duration,
    status: 'confirmed', patient_confirmed: 0, reminders_sent: [], source: b.source || 'demo', created_at: t, updated_at: t };
  state.bookings.push(row); persist(); return clone(row);
}
function getBooking(id) { const r = state.bookings.find(b => b.id === Number(id)); return r ? clone(r) : null; }
function updateBooking(b) {
  const i = state.bookings.findIndex(x => x.id === b.id);
  if (i < 0) return null;
  state.bookings[i] = clone({ ...state.bookings[i], name: b.name || null, service_id: b.service_id, date: b.date, time: b.time, duration: b.duration, status: b.status,
    patient_confirmed: b.patient_confirmed ? 1 : 0, reminders_sent: b.reminders_sent || [], updated_at: now() });
  persist(); return clone(state.bookings[i]);
}
const byTime = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);
function bookingsOnDate(clinicId, date) { return clone(state.bookings.filter(b => b.clinic_id === clinicId && b.date === date && b.status === 'confirmed')); }
function upcomingForPhone(clinicId, phone, todayStr, nowHHMM) {
  return clone(state.bookings.filter(b => b.clinic_id === clinicId && b.phone === phone && b.status === 'confirmed' && (b.date > todayStr || (b.date === todayStr && b.time >= nowHHMM))).sort(byTime).slice(0, 5));
}
function allUpcoming(clinicId, todayStr) { return clone(state.bookings.filter(b => b.clinic_id === clinicId && b.status === 'confirmed' && b.date >= todayStr).sort(byTime)); }
function listBookings(clinicId, limit = 50) { return clone(state.bookings.filter(b => b.clinic_id === clinicId).sort((a, b) => byTime(b, a)).slice(0, limit)); }
function lastNameForPhone(clinicId, phone) { const r = [...state.bookings].reverse().find(b => b.clinic_id === clinicId && b.phone === phone && b.name); return r ? r.name : null; }

function logMessage(clinicId, phone, direction, text) { state.messages.push({ id: state.messages.length + 1, clinic_id: clinicId, phone, direction, text, created_at: now() }); if (state.messages.length > 2000) state.messages.splice(0, 500); persist(); }
function recentMessages(clinicId, phone, limit = 50) { return clone(state.messages.filter(m => m.clinic_id === clinicId && m.phone === phone).slice(-limit)); }

function resetPhone(clinicId, phone) {
  delete state.conversations[ck(clinicId, phone)];
  state.bookings = state.bookings.filter(b => !(b.clinic_id === clinicId && b.phone === phone));
  state.messages = state.messages.filter(m => !(m.clinic_id === clinicId && m.phone === phone));
  persist();
}
function resetAll() { state = { conversations: {}, bookings: [], messages: [], nextId: 1 }; persist(); }
function stats(clinicId, todayStr, weekStartStr) {
  const bs = state.bookings.filter(b => b.clinic_id === clinicId);
  return {
    today: bs.filter(b => b.date === todayStr && b.status === 'confirmed').length,
    this_week: bs.filter(b => b.date >= weekStartStr && b.status === 'confirmed').length,
    confirmed_by_patient: bs.filter(b => b.status === 'confirmed' && b.patient_confirmed).length,
    total: bs.length,
  };
}

module.exports = { DB_PATH: 'memory', getConversation, saveConversation, createBooking, getBooking, updateBooking, bookingsOnDate, upcomingForPhone, allUpcoming, listBookings, lastNameForPhone, logMessage, recentMessages, resetPhone, resetAll, stats };
