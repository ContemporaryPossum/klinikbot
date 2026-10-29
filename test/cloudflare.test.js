// Exercises the Cloudflare path without wrangler: the Durable Object store adapter (over a fake ctx.storage.sql backed by
// node:sqlite) and the shared Request/Response router that both the Worker and the Node server use.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const store = require('../src/store');
const { createStore } = require('../src/store/db-do');
const { handleRequest } = require('../src/app');
const { AI } = require('../src/engine/conversation');
const whatsapp = require('../src/channels/whatsapp');
const clinic = require(path.join(__dirname, '..', 'clinics', 'demo-dental.json'));

// Fake of DurableObjectStorage.sql: exec(query, ...params) -> cursor with toArray()
function fakeSql() {
  const d = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => { const st = d.prepare(q); const rows = st.all(...p); return { toArray: () => rows, one: () => rows[0] }; } };
}

test('DO store: same behaviour as the SQLite store', () => {
  const db = createStore(fakeSql());
  const b = db.createBooking({ clinic_id: clinic.id, phone: '6011', name: 'Ali', service_id: 'checkup', date: '2030-01-07', time: '10:00', duration: 30, source: 'test' });
  assert.ok(b.id >= 1); assert.deepStrictEqual(b.reminders_sent, []);
  assert.strictEqual(db.bookingsOnDate(clinic.id, '2030-01-07').length, 1);
  b.reminders_sent = [24]; b.patient_confirmed = 1; const u = db.updateBooking(b);
  assert.deepStrictEqual(u.reminders_sent, [24]); assert.strictEqual(u.patient_confirmed, 1);
  assert.strictEqual(db.upcomingForPhone(clinic.id, '6011', '2030-01-01', '09:00').length, 1);
  assert.strictEqual(db.lastNameForPhone(clinic.id, '6011'), 'Ali');
  const c = db.getConversation(clinic.id, '6011'); c.lang = 'zh'; c.step = 'menu'; c.data = { x: 1 }; db.saveConversation(c);
  assert.deepStrictEqual(db.getConversation(clinic.id, '6011').data, { x: 1 });
  db.logMessage(clinic.id, '6011', 'in', 'hai'); db.logMessage(clinic.id, '6011', 'out', 'menu');
  assert.deepStrictEqual(db.recentMessages(clinic.id, '6011').map(m => m.direction), ['in', 'out']);
  assert.strictEqual(db.stats(clinic.id, '2030-01-07', '2030-01-06').today, 1);
  db.resetPhone(clinic.id, '6011');
  assert.strictEqual(db.listBookings(clinic.id).length, 0);
});

function deps(db, overrides = {}) {
  const sent = [];
  const fakeWa = { ...whatsapp, configured: () => true, send: async (to, m) => { sent.push({ to, m }); }, markRead: async () => {} };
  return { sent, deps: { clinic, db, whatsapp: fakeWa, deliverAny: async (to, m) => sent.push({ to, m }), log: { info() {}, error() {} }, serveStatic: async () => null, env: {}, ...overrides } };
}
const post = (url, body) => new Request('http://x' + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Router: health, webhook verify, inbound WhatsApp message gets a reply', async () => {
  const db = createStore(fakeSql());
  const { sent, deps: d } = deps(db);
  await store.run(db, async () => {
    let r = await handleRequest(new Request('http://x/health'), d);
    assert.strictEqual((await r.json()).ok, true);

    process.env.WHATSAPP_VERIFY_TOKEN = 'secret';
    r = await handleRequest(new Request('http://x/webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=4242'), d);
    assert.strictEqual(await r.text(), '4242');
    r = await handleRequest(new Request('http://x/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242'), d);
    assert.strictEqual(r.status, 403);

    const payload = { entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Ali' } }], messages: [{ from: '60123456789', id: 'wamid.1', type: 'text', text: { body: 'hai' } }] } }] }] };
    r = await handleRequest(post('/webhook', payload), d);
    assert.strictEqual((await r.json()).ok, true);
    assert.ok(sent.length >= 1);
    assert.match(sent[0].m.text, /Selamat datang/);
    assert.strictEqual(sent[0].to, '60123456789');
  });
});

test('Router: demo booking end-to-end over HTTP + reminder endpoint + cron hook', async () => {
  const db = createStore(fakeSql());
  const { sent, deps: d } = deps(db, { env: { INTERNAL_TOKEN: 't0k' } });
  await store.run(db, async () => {
    const say = async (text) => (await (await handleRequest(post('/api/demo/message', { phone: 'web1', text }), d)).json());
    let out = await say('book a filling next monday 3pm');
    out = await say('Sarah Lim');
    out = await say('yes');
    assert.ok(out.events.some(e => e.type === 'booking_created'));
    const id = out.events.find(e => e.type === 'booking_created').booking.id;
    assert.strictEqual(out.state.stats.total, 1);

    let r = await handleRequest(post('/api/demo/reminder', { booking_id: id, hours: 24 }), d);
    const j = await r.json();
    assert.match(j.sent.text, /reminder/i);
    assert.strictEqual(j.sent.template.key, 'reminder_24h');
    assert.strictEqual(j.sent.template.params[0], 'Sarah Lim');

    r = await handleRequest(new Request('http://x/internal/reminders', { method: 'POST' }), d);
    assert.strictEqual(r.status, 403);
    r = await handleRequest(new Request('http://x/internal/reminders', { method: 'POST', headers: { 'x-internal-token': 't0k' } }), d);
    assert.strictEqual((await r.json()).ok, true);
  });
});

test('Store registry isolates two clinics running concurrently', async () => {
  const a = createStore(fakeSql()), b = createStore(fakeSql());
  await Promise.all([
    store.run(a, async () => { await new Promise(r => setTimeout(r, 5)); store.logMessage('c', 'p', 'in', 'A'); }),
    store.run(b, async () => { store.logMessage('c', 'p', 'in', 'B'); await new Promise(r => setTimeout(r, 10)); }),
  ]);
  assert.deepStrictEqual(a.recentMessages('c', 'p').map(m => m.text), ['A']);
  assert.deepStrictEqual(b.recentMessages('c', 'p').map(m => m.text), ['B']);
});
