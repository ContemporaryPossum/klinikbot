// Store registry: the engine talks to whichever store the host registers (SQLite on Node, Durable Object SQLite on
// Cloudflare, in-memory in the browser demo). On Node/Workers the store is bound per request with AsyncLocalStorage so
// several clinics can share one process safely; elsewhere a single global store is used.
let fallback = null;
let als = null;
try { const { AsyncLocalStorage } = require('node:async_hooks'); als = AsyncLocalStorage ? new AsyncLocalStorage() : null; } catch (e) { als = null; }

function current() {
  const s = (als && als.getStore()) || fallback;
  if (!s) throw new Error('No store registered: call store.use(impl) or store.run(impl, fn)');
  return s;
}
function use(impl) { fallback = impl; }
function run(impl, fn) { return als ? als.run(impl, fn) : (fallback = impl, fn()); }

const METHODS = ['getConversation', 'saveConversation', 'createBooking', 'getBooking', 'updateBooking', 'bookingsOnDate', 'upcomingForPhone',
  'allUpcoming', 'listBookings', 'lastNameForPhone', 'logMessage', 'recentMessages', 'resetPhone', 'stats'];
const api = { use, run, current };
for (const m of METHODS) api[m] = (...a) => current()[m](...a);
Object.defineProperty(api, 'DB_PATH', { get: () => current().DB_PATH });
module.exports = api;
