// Shared HTTP app, written against the web-standard Request/Response so it runs unchanged on Node and Cloudflare Workers.
//
// handleRequest(request, deps) -> Response
// deps: { clinic, db, whatsapp, deliverAny(phone, msg), log, serveStatic(path) -> Response|null, env }
const S = require('./engine/scheduling');
const { handle, AI } = require('./engine/conversation');
const reminders = require('./reminders');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function text(body, status = 200) { return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }

// The demo page and the clinic dashboard share one database with the real WhatsApp line. Without the internal token a
// caller is in DEMO mode: it may only use demo identities (anything that is not a phone number, e.g. "web1") and only
// sees demo-sourced bookings. With the token (header x-internal-token or ?token=) it is the clinic's dashboard and sees
// everything, including WhatsApp bookings, and may mark them done / no-show or resend a reminder.
const isRealPhone = (p) => /^\d{8,15}$/.test(String(p || ''));
function isAdmin(request, url, deps) {
  const tok = deps.env && deps.env.INTERNAL_TOKEN;
  return !!tok && (request.headers.get('x-internal-token') === tok || url.searchParams.get('token') === tok);
}

function demoState(deps, phone, admin = false) {
  const { clinic, db } = deps;
  const today = S.todayStr(clinic);
  let bookings = db.listBookings(clinic.id, admin ? 200 : 40);
  let stats = db.stats(clinic.id, today, S.startOfWeek(today));
  if (!admin) {
    bookings = bookings.filter(b => b.source === 'demo' || !isRealPhone(b.phone));
    const weekStart = S.startOfWeek(today);
    stats = {
      today: bookings.filter(b => b.date === today && b.status === 'confirmed').length,
      this_week: bookings.filter(b => b.date >= weekStart && b.status === 'confirmed').length,
      confirmed_by_patient: bookings.filter(b => b.status === 'confirmed' && b.patient_confirmed).length,
      total: bookings.length,
    };
  }
  const showPhone = phone && (admin || !isRealPhone(phone));
  return {
    clinic: { id: clinic.id, name: clinic.name, short_name: clinic.short_name, address: clinic.address, services: clinic.services, hours: clinic.hours, default_language: clinic.default_language, deposit: clinic.deposit, reminders: clinic.reminders, ai: { persona: (clinic.ai || {}).persona } },
    ai: AI.available(),
    mode: admin ? 'dashboard' : 'demo',
    today, now: S.localParts(new Date(), clinic.timezone).timeStr,
    messages: showPhone ? db.recentMessages(clinic.id, phone, 100) : [],
    bookings,
    stats,
    conversation: showPhone ? db.getConversation(clinic.id, phone) : null,
  };
}

// One-line description of a Meta webhook payload for the logs (no message bodies).
function summarizeWebhook(payload) {
  try {
    const parts = [];
    for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const msgs = (v.messages || []).map(m => `${m.type}:${m.from}`);
      const sts = (v.statuses || []).map(s => `${s.status}`);
      parts.push(`${ch.field}${msgs.length ? ' messages=' + msgs.join(',') : ''}${sts.length ? ' statuses=' + sts.join(',') : ''}${v.errors ? ' errors=' + JSON.stringify(v.errors).slice(0, 200) : ''}`);
    }
    return parts.join(' | ') || `object=${payload.object || '?'} keys=${Object.keys(payload || {}).join(',')}`;
  } catch (e) { return 'unparseable'; }
}

async function handleRequest(request, deps) {
  const { clinic, db, whatsapp, deliverAny, log } = deps;
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;
  const body = async () => { try { return await request.json(); } catch (e) { return {}; } };

  try {
    if (method === 'GET' && (p === '/' || p === '/demo')) return (await deps.serveStatic('demo.html')) || text('demo.html missing', 404);
    if (method === 'GET' && p === '/health') return json({ ok: true, clinic: clinic.id, whatsapp: whatsapp.configured(), ai: AI.available(), db: db.DB_PATH, now: new Date().toISOString() });

    // --- WhatsApp webhook ---
    if (p === '/webhook' && method === 'GET') {
      const challenge = whatsapp.verify(Object.fromEntries(url.searchParams));
      return challenge ? text(challenge) : text('Forbidden', 403);
    }
    if (p === '/webhook' && method === 'POST') {
      const payload = await body();
      const inbound = whatsapp.parseInbound(payload);
      log.info(`[webhook] inbound=${inbound.length} ${summarizeWebhook(payload)}`);
      const work = (async () => {
        for (const m of inbound) {
          try {
            whatsapp.markRead(m.messageId);
            const out = await handle(clinic, m.from, { text: m.text, buttonId: m.buttonId }, { source: 'whatsapp', log });
            log.info(`[webhook] from=${m.from} text=${JSON.stringify((m.text || '').slice(0, 60))} replies=${out.replies.length}`);
            for (const r of out.replies) {
              const res = await whatsapp.send(m.from, r);
              log.info(`[webhook] sent to=${m.from} id=${res && res.messages && res.messages[0] ? res.messages[0].id : '?'}`);
            }
            for (const ev of out.events) log.info(`[event] ${ev.type} ${m.from}`);
          } catch (e) { log.error('[webhook]', e && e.message || e); }
        }
      })();
      if (deps.waitUntil) deps.waitUntil(work); else await work;   // Workers: ack fast, keep working; Node: just finish
      return json({ ok: true });
    }

    // --- scheduler hook (Cloudflare cron calls this; Node runs its own timer) ---
    if (p === '/internal/reminders' && method === 'POST') {
      if (deps.env && deps.env.INTERNAL_TOKEN && request.headers.get('x-internal-token') !== deps.env.INTERNAL_TOKEN) return text('Forbidden', 403);
      const sent = await reminders.runOnce(clinic, deliverAny, log);
      return json({ ok: true, sent });
    }

    // --- WhatsApp setup diagnostics (GET = check, POST = check + subscribe this app to the WABA) ---
    if (p === '/internal/whatsapp' && (method === 'GET' || method === 'POST')) {
      const tok = deps.env && deps.env.INTERNAL_TOKEN;
      if (!tok) return text('Set INTERNAL_TOKEN first', 403);
      if (request.headers.get('x-internal-token') !== tok && url.searchParams.get('token') !== tok) return text('Forbidden', 403);
      const wabaId = url.searchParams.get('waba') || (deps.env && deps.env.WHATSAPP_WABA_ID) || undefined;
      const result = whatsapp.diagnose ? await whatsapp.diagnose({ wabaId, subscribe: method === 'POST' || url.searchParams.get('subscribe') === '1' }) : { error: 'diagnose unavailable' };
      return json(result);
    }

    // --- WhatsApp template management (GET = list + status, ?create=1 or POST = submit missing reminder templates) ---
    if (p === '/internal/templates' && (method === 'GET' || method === 'POST')) {
      const tok = deps.env && deps.env.INTERNAL_TOKEN;
      if (!tok) return text('Set INTERNAL_TOKEN first', 403);
      if (request.headers.get('x-internal-token') !== tok && url.searchParams.get('token') !== tok) return text('Forbidden', 403);
      const wabaId = url.searchParams.get('waba') || (deps.env && deps.env.WHATSAPP_WABA_ID) || undefined;
      const result = whatsapp.manageTemplates ? await whatsapp.manageTemplates({ wabaId, create: method === 'POST' || url.searchParams.get('create') === '1' }) : { error: 'unavailable' };
      return json(result);
    }

    // --- demo API / clinic dashboard API (see demoState for the demo-vs-dashboard rule) ---
    const admin = isAdmin(request, url, deps);
    const demoOnly = (phone) => !admin && isRealPhone(phone);   // a real patient's number without the token
    if (p === '/api/demo/message' && method === 'POST') {
      const b = await body();
      const phone = String(b.phone || 'demo');
      if (demoOnly(phone)) return json({ error: 'Demo identities only. Use a name like "web1", not a phone number.' }, 403);
      const out = await handle(clinic, phone, { text: b.text, buttonId: b.buttonId }, { source: 'demo', log });
      for (const ev of out.events) log.info(`[event] ${ev.type} ${phone}`);
      return json({ replies: out.replies, events: out.events, state: demoState(deps, phone, admin) });
    }
    if (p === '/api/demo/state' && method === 'GET') return json(demoState(deps, url.searchParams.get('phone'), admin));
    if (p === '/api/demo/reminder' && method === 'POST') {
      const b = await body();
      const bk = db.getBooking(Number(b.booking_id));
      if (!bk) return json({ error: 'booking not found' }, 404);
      if (demoOnly(bk.phone)) return json({ error: 'Dashboard token required to message a real patient.' }, 403);
      const msg = await reminders.sendReminder(clinic, bk, Number(b.hours || 24), deliverAny, log);
      return json({ sent: msg, state: demoState(deps, bk.phone, admin) });
    }
    if (p === '/api/demo/reset' && method === 'POST') {
      const b = await body();
      const phone = String(b.phone || 'demo');
      if (demoOnly(phone)) return json({ error: 'Dashboard token required to reset a real patient.' }, 403);
      db.resetPhone(clinic.id, phone);
      return json({ ok: true, state: demoState(deps, phone, admin) });
    }
    if (p === '/api/demo/booking' && method === 'POST') {
      const b = await body();
      const bk = db.getBooking(Number(b.booking_id));
      if (!bk) return json({ error: 'booking not found' }, 404);
      if (demoOnly(bk.phone)) return json({ error: 'Dashboard token required to change a real booking.' }, 403);
      if (['completed', 'no_show', 'cancelled', 'confirmed'].includes(b.status)) bk.status = b.status;
      db.updateBooking(bk);
      return json({ ok: true, state: demoState(deps, bk.phone, admin) });
    }

    if (method === 'GET') return (await deps.serveStatic(p.slice(1))) || text('Not found', 404);
    return text('Not found', 404);
  } catch (e) {
    log.error(e);
    return json({ error: e && e.message || String(e) }, 500);
  }
}

module.exports = { handleRequest, demoState };
