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

function demoState(deps, phone) {
  const { clinic, db } = deps;
  const today = S.todayStr(clinic);
  return {
    clinic: { id: clinic.id, name: clinic.name, short_name: clinic.short_name, address: clinic.address, services: clinic.services, hours: clinic.hours, default_language: clinic.default_language, deposit: clinic.deposit, reminders: clinic.reminders, ai: { persona: (clinic.ai || {}).persona } },
    ai: AI.available(),
    today, now: S.localParts(new Date(), clinic.timezone).timeStr,
    messages: phone ? db.recentMessages(clinic.id, phone, 100) : [],
    bookings: db.listBookings(clinic.id, 40),
    stats: db.stats(clinic.id, today, S.startOfWeek(today)),
    conversation: phone ? db.getConversation(clinic.id, phone) : null,
  };
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
      const work = (async () => {
        for (const m of whatsapp.parseInbound(payload)) {
          try {
            whatsapp.markRead(m.messageId);
            const out = await handle(clinic, m.from, { text: m.text, buttonId: m.buttonId }, { source: 'whatsapp', log });
            for (const r of out.replies) await whatsapp.send(m.from, r);
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

    // --- demo API ---
    if (p === '/api/demo/message' && method === 'POST') {
      const b = await body();
      const phone = String(b.phone || 'demo');
      const out = await handle(clinic, phone, { text: b.text, buttonId: b.buttonId }, { source: 'demo', log });
      for (const ev of out.events) log.info(`[event] ${ev.type} ${phone}`);
      return json({ replies: out.replies, events: out.events, state: demoState(deps, phone) });
    }
    if (p === '/api/demo/state' && method === 'GET') return json(demoState(deps, url.searchParams.get('phone')));
    if (p === '/api/demo/reminder' && method === 'POST') {
      const b = await body();
      const bk = db.getBooking(Number(b.booking_id));
      if (!bk) return json({ error: 'booking not found' }, 404);
      const msg = await reminders.sendReminder(clinic, bk, Number(b.hours || 24), deliverAny, log);
      return json({ sent: msg, state: demoState(deps, bk.phone) });
    }
    if (p === '/api/demo/reset' && method === 'POST') {
      const b = await body();
      db.resetPhone(clinic.id, String(b.phone || 'demo'));
      return json({ ok: true, state: demoState(deps, String(b.phone || 'demo')) });
    }
    if (p === '/api/demo/booking' && method === 'POST') {
      const b = await body();
      const bk = db.getBooking(Number(b.booking_id));
      if (!bk) return json({ error: 'booking not found' }, 404);
      if (['completed', 'no_show', 'cancelled', 'confirmed'].includes(b.status)) bk.status = b.status;
      db.updateBooking(bk);
      return json({ ok: true, state: demoState(deps, bk.phone) });
    }

    if (method === 'GET') return (await deps.serveStatic(p.slice(1))) || text('Not found', 404);
    return text('Not found', 404);
  } catch (e) {
    log.error(e);
    return json({ error: e && e.message || String(e) }, 500);
  }
}

module.exports = { handleRequest, demoState };
