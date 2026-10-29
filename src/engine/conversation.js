// The booking conversation state machine. Channel-agnostic: takes text in, returns replies out.
const db = require('../store');
const S = require('./scheduling');
const P = require('./parser');
const { M } = require('./messages');
const AI = require('./ai');

const nowInstant = () => new Date();

function reply(text, buttons) { return buttons ? { text, buttons } : { text }; }

function svc(clinic, id) { return clinic.services.find(s => s.id === id); }

function slotsFor(clinic, dateStr, duration) {
  return S.availableSlots(clinic, dateStr, duration, db.bookingsOnDate(clinic.id, dateStr), nowInstant());
}

// Next n open dates that still have at least one free slot.
function openDatesWithSlots(clinic, fromDate, duration, n) {
  return S.nextOpenDates(clinic, fromDate, 10).filter(x => slotsFor(clinic, x, duration).length).slice(0, n);
}

function nearestSlots(slots, hhmm, n = 4) {
  const t = S.toMinutes(hhmm);
  return [...slots].sort((a, b) => Math.abs(S.toMinutes(a) - t) - Math.abs(S.toMinutes(b) - t)).slice(0, n).sort();
}

// ---- main entry ----
// input: { text, buttonId? }  -> { replies: [{text, buttons?}], events: [{type, ...}] , conv }
async function handle(clinic, phone, input, opts = {}) {
  const text = (input.buttonId ? buttonToText(input.buttonId) : input.text) || '';
  const conv = db.getConversation(clinic.id, phone);
  const events = [];
  const today = S.todayStr(clinic, nowInstant());
  if (!conv.name) conv.name = db.lastNameForPhone(clinic.id, phone);

  db.logMessage(clinic.id, phone, 'in', text);

  // language
  const detected = P.detectLanguage(text);
  const explicitSwitch = /\b(english|in english|eng)\b/i.test(text) ? 'en' : /\b(bm|bahasa|melayu|malay)\b/i.test(text) ? 'ms' : /中文|华语|华文|chinese|mandarin/i.test(text) ? 'zh' : null;
  const clearSentence = P.hasCJK(text) ? text.replace(/[^\u4e00-\u9fff]/g, '').length >= 2 : P.norm(text).split(' ').length >= 3;
  if (explicitSwitch) conv.lang = explicitSwitch;
  else if (!conv.lang) conv.lang = detected || clinic.default_language || 'ms';
  else if (detected && detected !== conv.lang && clearSentence) conv.lang = detected; // switch on a clear sentence
  if (!M[conv.lang]) conv.lang = clinic.default_language || 'ms';
  const L = M[conv.lang];
  const ctx = { clinic, phone, conv, L, today, events, replies: [], source: opts.source, log: opts.log, rawText: text };
  const say = (t, b) => ctx.replies.push(reply(t, b));

  if (explicitSwitch && (P.hasCJK(text) ? text.replace(/[^\u4e00-\u9fff]/g, '').length <= 4 : P.norm(text).split(' ').length <= 2)) {
    say(L.langSwitched());
    if (conv.step === 'idle' || conv.step === 'menu') { say(L.menu()); conv.step = 'menu'; }
    return finish(ctx);
  }

  const t = P.norm(text);
  const intent = P.detectIntent(text);

  // global: back to menu
  if (/^(menu|mula|start|home|utama|\/start|菜单|主菜单|开始|返回)$/.test(t)) {
    conv.handoff_until = null; conv.data = {}; conv.step = 'menu';
    say(L.greeting(clinic, conv.name)); say(L.menu(), L.menuButtons());
    return finish(ctx);
  }

  // handoff active: stay quiet after first notice
  if (conv.handoff_until && conv.handoff_until > Date.now()) {
    if (!conv.data.handoff_notified) { conv.data.handoff_notified = true; say(L.handoffActive()); }
    return finish(ctx);
  }

  // global: staff
  if (intent === 'staff') return doHandoff(ctx);

  // reminder quick replies take priority when a reminder is pending
  if (conv.last_reminder_booking_id && (conv.step === 'idle' || conv.step === 'menu')) {
    const b = db.getBooking(conv.last_reminder_booking_id);
    if (b && b.status === 'confirmed') {
      if (input.buttonId === 'rem_yes' || P.pickNumber(text, 3) === 1 || P.isYes(text) || /\b(datang|be there|coming|confirm)\b/.test(t) || /会到|会来|能到|准时|我会去/.test(t)) {
        b.patient_confirmed = 1; db.updateBooking(b); conv.last_reminder_booking_id = null;
        events.push({ type: 'patient_confirmed', booking: b });
        say(L.reminderConfirmed()); return finish(ctx);
      }
      if (input.buttonId === 'rem_resched' || P.pickNumber(text, 3) === 2 || intent === 'reschedule') {
        conv.last_reminder_booking_id = null; return startReschedule(ctx, b);
      }
      if (input.buttonId === 'rem_cancel' || P.pickNumber(text, 3) === 3 || intent === 'cancel') {
        conv.last_reminder_booking_id = null; conv.data = { booking_id: b.id }; conv.step = 'cancel_confirm';
        say(L.cancelConfirm(b, today)); return finish(ctx);
      }
    } else conv.last_reminder_booking_id = null;
  }

  switch (conv.step) {
    case 'idle':
    case 'menu': return onIdle(ctx, text, intent, input.buttonId);
    case 'book_service': return onService(ctx, text);
    case 'book_date': return onDate(ctx, text);
    case 'book_time': return onTime(ctx, text);
    case 'book_name': return onName(ctx, text);
    case 'book_confirm': return onConfirm(ctx, text, input.buttonId);
    case 'fix_what': return onFixWhat(ctx, text);
    case 'manage_pick': return onManagePick(ctx, text);
    case 'manage_what': return onManageWhat(ctx, text, intent);
    case 'cancel_confirm': return onCancelConfirm(ctx, text, input.buttonId);
    default: conv.step = 'idle'; return onIdle(ctx, text, intent, input.buttonId);
  }
}

function buttonToText(id) {
  return { book: '1', manage: '2', info: '3', yes: 'yes', no: 'no', rem_yes: '1', rem_resched: '2', rem_cancel: '3' }[id] || id;
}

async function finish(ctx) {
  const { clinic, phone, conv } = ctx;
  if (ctx.wantAI) {
    const req = ctx.wantAI; ctx.wantAI = null;
    const history = db.recentMessages(clinic.id, phone, 12);
    const ai = await AI.answer(clinic, conv, history, req.text, { log: ctx.log });
    if (ai) {
      ctx.events.push({ type: 'ai_answered', phone, question: req.text });
      if (ai.text) ctx.replies.push(reply(ai.text));
      if (ai.action && req.allowActions !== false) {
        const r = await runAction(ctx, ai.action);
        if (r) return r; // action handler already finished
      }
      if (req.followUp) ctx.replies.push(req.followUp);
    } else {
      for (const r of req.fallback || []) ctx.replies.push(r);
    }
  }
  db.saveConversation(conv);
  for (const r of ctx.replies) db.logMessage(clinic.id, phone, 'out', r.text);
  return { replies: ctx.replies, events: ctx.events, conv };
}

// The AI asked the engine to take over (book / manage / handoff).
function runAction(ctx, action) {
  const { clinic, conv } = ctx;
  if (action.type === 'book') {
    conv.data = { mode: 'book' };
    const s = action.service_id ? svc(clinic, action.service_id) : null;
    if (s) conv.data.service_id = s.id;
    // keep any date/time the patient already mentioned ("boleh buat scaling esok petang?")
    const date = P.parseDate(ctx.rawText || '', ctx.today); if (date && date >= ctx.today) conv.data.date = date;
    const time = P.parseTime(ctx.rawText || ''); if (time) conv.data.timeHint = time;
    return advanceBooking(ctx);
  }
  if (action.type === 'manage') return startManage(ctx, null);
  if (action.type === 'handoff') return doHandoff(ctx);
  return null;
}

// Ask the AI instead of the scripted prompt, when it is available and the message reads like a question.
// Returns true when the AI will answer (caller should `return finish(ctx)`).
function deferToAI(ctx, text, { followUp = null, fallback = [], allowActions = true } = {}) {
  if (!AI.available() || !AI.looksLikeQuestion(text)) return false;
  ctx.wantAI = { text, followUp, fallback, allowActions };
  return true;
}

// ---- idle / menu ----
function onIdle(ctx, text, intent, buttonId) {
  const { clinic, conv, L, today } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const n = conv.step === 'menu' ? P.pickNumber(text, 4) : null;
  const choice = buttonId === 'book' || n === 1 ? 'book' : buttonId === 'manage' || n === 2 ? 'manage' : buttonId === 'info' || n === 3 ? 'info' : n === 4 ? 'staff' : null;

  if (choice === 'staff') return doHandoff(ctx);
  if (choice === 'info' || intent === 'hours' || intent === 'location') { say(L.info(clinic)); conv.step = 'menu'; return finish(ctx); }
  if (choice === 'manage' || intent === 'cancel' || intent === 'reschedule') return startManage(ctx, intent);
  if (intent === 'thanks') { say(L.thanks()); conv.step = 'idle'; return finish(ctx); }

  // Booking: either explicit, or the message already contains a service/date/time
  const isBareNumber = /^\s*\d{1,2}\s*$/.test(text);
  const service = isBareNumber ? null : P.matchService(text, clinic.services);
  const date = P.parseDate(text, today);
  const time = P.parseTime(text);
  // "boleh buat scaling esok?" is a question first; the AI answers and, if it starts a booking, the date/time hints are kept.
  const question = AI.available() && AI.looksLikeQuestion(text) && intent !== 'book' && choice !== 'book';
  const explicitBook = choice === 'book' || intent === 'book' || (!!date && !question);
  // A question that is not an explicit booking request goes to the AI first ("scaling sakit tak?", "ada parking?")
  if (!explicitBook && AI.available() && (intent === 'price' || AI.looksLikeQuestion(text))) {
    conv.step = 'menu';
    ctx.wantAI = { text, fallback: [reply(intent === 'price' ? L.priceList(clinic) : L.fallback())] };
    return finish(ctx);
  }
  if (intent === 'price') { say(L.priceList(clinic)); conv.step = 'menu'; return finish(ctx); }
  if (explicitBook || service || (time && conv.step === 'menu')) {
    conv.data = { mode: 'book' };
    if (service) conv.data.service_id = service.id;
    if (date) conv.data.date = date;
    if (time) conv.data.timeHint = time;
    return advanceBooking(ctx);
  }

  if (intent === 'greeting' || (conv.step === 'idle' && !AI.available())) {
    say(L.greeting(clinic, conv.name)); say(L.menu(), L.menuButtons()); conv.step = 'menu'; return finish(ctx);
  }
  // Anything else: let the AI reply like a human would; otherwise the scripted fallback.
  if (AI.available()) { conv.step = 'menu'; ctx.wantAI = { text, fallback: [reply(L.fallback())] }; return finish(ctx); }
  say(L.fallback()); return finish(ctx);
}

// ---- booking flow ----
// Moves to the next missing piece of a booking.
function advanceBooking(ctx) {
  const { clinic, conv, L, today } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const d = conv.data;

  if (!d.service_id) { conv.step = 'book_service'; say(L.askService(clinic)); return finish(ctx); }
  const s = svc(clinic, d.service_id);

  if (!d.date) {
    conv.step = 'book_date';
    d.dateOptions = openDatesWithSlots(clinic, today, s.duration, 3);
    say(L.askDateWithOptions(d.dateOptions, today)); return finish(ctx);
  }
  if (!d.time) {
    const slots = slotsFor(clinic, d.date, s.duration);
    if (!slots.length) {
      const alts = openDatesWithSlots(clinic, S.addDays(d.date, 1), s.duration, 3);
      d.dateOptions = alts; d.date = null; conv.step = 'book_date';
      say(L.noSlots(d.date, today, alts)); return finish(ctx);
    }
    // apply a time hint from the original message
    if (d.timeHint) {
      const hint = d.timeHint; d.timeHint = null;
      if (hint.time) {
        if (slots.includes(hint.time)) { d.time = hint.time; return advanceBooking(ctx); }
        d.slots = nearestSlots(slots, hint.time); conv.step = 'book_time'; say(L.timeTaken(hint.time, d.slots)); return finish(ctx);
      }
      if (hint.period) {
        const f = slots.filter(P.periodFilter(hint.period));
        d.slots = f.length ? f.slice(0, 6) : slots.slice(0, 6); conv.step = 'book_time';
        say(f.length ? L.askTime(d.date, today, d.slots) : L.noSlotsPeriod(d.slots)); return finish(ctx);
      }
    }
    d.slots = slots.slice(0, 6); conv.step = 'book_time'; say(L.askTime(d.date, today, d.slots)); return finish(ctx);
  }
  if (!d.name) {
    if (conv.name) d.name = conv.name;
    else { conv.step = 'book_name'; say(L.askName()); return finish(ctx); }
  }
  conv.step = 'book_confirm';
  const preview = { name: d.name, date: d.date, time: d.time };
  say(L.confirm(clinic, preview, s, today), L.confirmButtons());
  return finish(ctx);
}

function onService(ctx, text) {
  const { clinic, conv, L } = ctx;
  const s = P.matchService(text, clinic.services);
  if (!s) {
    if (deferToAI(ctx, text, { followUp: reply(L.askService(clinic)), fallback: [reply(L.askService(clinic))], allowActions: false })) return finish(ctx);
    ctx.replies.push(reply(L.askService(clinic))); return finish(ctx);
  }
  conv.data.service_id = s.id;
  // the same message may also carry a date/time
  const date = P.parseDate(text, ctx.today); if (date && !conv.data.date) conv.data.date = date;
  const time = P.parseTime(text); if (time) conv.data.timeHint = time;
  return advanceBooking(ctx);
}

function onDate(ctx, text) {
  const { clinic, conv, L, today } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const d = conv.data;
  const s = svc(clinic, d.service_id);
  let date = null;
  const n = P.pickNumber(text, (d.dateOptions || []).length);
  if (n) date = d.dateOptions[n - 1];
  else date = P.parseDate(text, today);
  if (!date) {
    if (deferToAI(ctx, text, { followUp: reply(L.askDate()), fallback: [reply(L.askDate())], allowActions: false })) return finish(ctx);
    say(L.askDate()); return finish(ctx);
  }
  if (date < today) { say(L.pastDate()); return finish(ctx); }
  if (!S.withinBookingWindow(clinic, date, nowInstant())) { say(L.tooFar(clinic.max_days_ahead || 14)); return finish(ctx); }
  if (!S.isOpen(clinic, date)) {
    const alts = openDatesWithSlots(clinic, S.addDays(date, 1), s.duration, 3);
    d.dateOptions = alts; say(L.closedOn(date, today, alts)); return finish(ctx);
  }
  if (!slotsFor(clinic, date, s.duration).length) {
    const alts = openDatesWithSlots(clinic, S.addDays(date, 1), s.duration, 3);
    d.dateOptions = alts; say(L.noSlots(date, today, alts)); return finish(ctx);
  }
  d.date = date;
  const time = P.parseTime(text); if (time) d.timeHint = time;
  return advanceBooking(ctx);
}

function onTime(ctx, text) {
  const { clinic, conv, L, today } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const d = conv.data;
  const s = svc(clinic, d.service_id);
  const all = slotsFor(clinic, d.date, s.duration);
  const n = P.pickNumber(text, (d.slots || []).length);
  if (n) { d.time = d.slots[n - 1]; }
  else {
    // maybe they changed the date instead
    const newDate = P.parseDate(text, today);
    const parsed = P.parseTime(text);
    if (newDate && newDate !== d.date && !parsed) { d.date = null; d.time = null; return onDate(ctx, text); }
    if (newDate && newDate !== d.date && parsed) { d.date = null; d.time = null; d.timeHint = parsed; return onDate(ctx, text); }
    if (!parsed) {
      const ask = reply(L.askTime(d.date, today, d.slots || all.slice(0, 6)));
      if (deferToAI(ctx, text, { followUp: ask, fallback: [ask], allowActions: false })) return finish(ctx);
      say(ask.text); return finish(ctx);
    }
    if (parsed.time) {
      if (!all.includes(parsed.time)) { d.slots = nearestSlots(all, parsed.time); say(L.timeTaken(parsed.time, d.slots)); return finish(ctx); }
      d.time = parsed.time;
    } else {
      const f = all.filter(P.periodFilter(parsed.period));
      d.slots = (f.length ? f : all).slice(0, 6);
      say(f.length ? L.askTime(d.date, today, d.slots) : L.noSlotsPeriod(d.slots)); return finish(ctx);
    }
  }
  if (!all.includes(d.time)) { d.time = null; d.slots = all.slice(0, 6); say(L.askTime(d.date, today, d.slots)); return finish(ctx); }
  return d.mode === 'resched' ? confirmReschedule(ctx) : advanceBooking(ctx);
}

function onName(ctx, text) {
  const { conv, L } = ctx;
  const name = P.extractName(text);
  if (!name || AI.looksLikeQuestion(text)) {
    if (deferToAI(ctx, text, { followUp: reply(L.askName()), fallback: [reply(L.askName())], allowActions: false })) return finish(ctx);
    if (!name) { ctx.replies.push(reply(L.askName())); return finish(ctx); }
  }
  conv.data.name = name; conv.name = name;
  return advanceBooking(ctx);
}

function onConfirm(ctx, text, buttonId) {
  const { clinic, conv, L, today, events } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const d = conv.data;
  if (buttonId === 'yes' || P.isYes(text)) {
    const s = svc(clinic, d.service_id);
    // re-check the slot is still free
    const all = slotsFor(clinic, d.date, s.duration);
    if (!all.includes(d.time)) {
      const wanted = d.time; d.time = null; d.slots = nearestSlots(all, wanted || all[0] || '09:00');
      conv.step = 'book_time'; say(L.timeTaken(wanted || '09:00', d.slots)); return finish(ctx);
    }
    if (d.mode === 'resched' && d.booking_id) {
      const b = db.getBooking(d.booking_id);
      b.date = d.date; b.time = d.time; b.patient_confirmed = 0; b.reminders_sent = [];
      const updated = db.updateBooking(b);
      events.push({ type: 'booking_rescheduled', booking: updated });
      say(L.rescheduled(clinic, updated, s, today));
    } else {
      const b = db.createBooking({ clinic_id: clinic.id, phone: ctx.phone, name: d.name, service_id: s.id, date: d.date, time: d.time, duration: s.duration, source: ctx.source || 'whatsapp' });
      events.push({ type: 'booking_created', booking: b });
      say(L.booked(clinic, b, s, today));
      if (clinic.deposit && clinic.deposit.enabled) say(L.deposit(clinic));
    }
    conv.data = {}; conv.step = 'idle';
    return finish(ctx);
  }
  if (buttonId === 'no' || P.isNo(text)) { conv.step = 'fix_what'; say(L.notConfirmed()); return finish(ctx); }
  // they may have typed a correction directly
  const newDate = P.parseDate(text, today); const newTime = P.parseTime(text); const newSvc = P.matchService(text, clinic.services);
  if (newDate || newTime || newSvc) {
    if (newSvc) d.service_id = newSvc.id;
    if (newDate) { d.date = newDate; d.time = null; }
    if (newTime) { d.time = null; d.timeHint = newTime; }
    return advanceBooking(ctx);
  }
  const s = svc(clinic, d.service_id);
  say(L.confirm(clinic, { name: d.name, date: d.date, time: d.time }, s, today), L.confirmButtons());
  return finish(ctx);
}

function onFixWhat(ctx, text) {
  const { clinic, conv, L } = ctx;
  const n = P.pickNumber(text, 5);
  const d = conv.data;
  if (n === 1) { d.service_id = null; d.time = null; return advanceBooking(ctx); }
  if (n === 2) { d.date = null; d.time = null; return advanceBooking(ctx); }
  if (n === 3) { d.time = null; return advanceBooking(ctx); }
  if (n === 4) { d.name = null; conv.name = null; conv.step = 'book_name'; ctx.replies.push(reply(L.askName())); return finish(ctx); }
  if (n === 5 || P.isNo(text)) { conv.data = {}; conv.step = 'menu'; ctx.replies.push(reply(L.menu(), L.menuButtons())); return finish(ctx); }
  // free-text correction
  const newDate = P.parseDate(text, ctx.today); const newTime = P.parseTime(text); const newSvc = P.matchService(text, clinic.services);
  if (newSvc) d.service_id = newSvc.id;
  if (newDate) { d.date = newDate; d.time = null; }
  if (newTime) { d.time = null; d.timeHint = newTime; }
  if (newDate || newTime || newSvc) return advanceBooking(ctx);
  ctx.replies.push(reply(L.notConfirmed())); return finish(ctx);
}

// ---- manage (reschedule / cancel) ----
function startManage(ctx, intent) {
  const { clinic, phone, conv, L, today } = ctx;
  const say = (t, b) => ctx.replies.push(reply(t, b));
  const nowP = S.localParts(nowInstant(), clinic.timezone);
  const bs = db.upcomingForPhone(clinic.id, phone, today, nowP.timeStr);
  if (!bs.length) { say(L.noUpcoming()); conv.step = 'menu'; return finish(ctx); }
  if (bs.length === 1) {
    const b = bs[0];
    if (intent === 'reschedule') return startReschedule(ctx, b);
    if (intent === 'cancel') { conv.data = { booking_id: b.id }; conv.step = 'cancel_confirm'; say(L.cancelConfirm(b, today)); return finish(ctx); }
    conv.data = { booking_id: b.id }; conv.step = 'manage_what'; say(L.manageWhat(b, svc(clinic, b.service_id), today)); return finish(ctx);
  }
  conv.data = { bookingOptions: bs.map(b => b.id), pendingIntent: intent || null }; conv.step = 'manage_pick';
  say(L.yourBookings(bs, clinic.services, today)); return finish(ctx);
}

function onManagePick(ctx, text) {
  const { clinic, conv, L, today } = ctx;
  const n = P.pickNumber(text, (conv.data.bookingOptions || []).length);
  if (!n) { const bs = conv.data.bookingOptions.map(id => db.getBooking(id)); ctx.replies.push(reply(L.yourBookings(bs, clinic.services, today))); return finish(ctx); }
  const b = db.getBooking(conv.data.bookingOptions[n - 1]);
  const pi = conv.data.pendingIntent;
  if (pi === 'reschedule') return startReschedule(ctx, b);
  if (pi === 'cancel') { conv.data = { booking_id: b.id }; conv.step = 'cancel_confirm'; ctx.replies.push(reply(L.cancelConfirm(b, today))); return finish(ctx); }
  conv.data = { booking_id: b.id }; conv.step = 'manage_what';
  ctx.replies.push(reply(L.manageWhat(b, svc(clinic, b.service_id), today))); return finish(ctx);
}

function onManageWhat(ctx, text, intent) {
  const { clinic, conv, L, today } = ctx;
  const b = db.getBooking(conv.data.booking_id);
  const n = P.pickNumber(text, 3);
  if (n === 1 || intent === 'reschedule') return startReschedule(ctx, b);
  if (n === 2 || intent === 'cancel') { conv.step = 'cancel_confirm'; ctx.replies.push(reply(L.cancelConfirm(b, today))); return finish(ctx); }
  if (n === 3 || P.isNo(text)) { conv.data = {}; conv.step = 'idle'; ctx.replies.push(reply(L.thanks())); return finish(ctx); }
  ctx.replies.push(reply(L.manageWhat(b, svc(clinic, b.service_id), today))); return finish(ctx);
}

function startReschedule(ctx, b) {
  const { clinic, conv, L, today } = ctx;
  conv.data = { mode: 'resched', booking_id: b.id, service_id: b.service_id, name: b.name };
  conv.step = 'book_date';
  const s = svc(clinic, b.service_id);
  conv.data.dateOptions = openDatesWithSlots(clinic, today, s.duration, 3);
  ctx.replies.push(reply(L.askDateWithOptions(conv.data.dateOptions, today)));
  return finish(ctx);
}

function confirmReschedule(ctx) {
  const { clinic, conv, L, today } = ctx;
  const d = conv.data; const s = svc(clinic, d.service_id);
  conv.step = 'book_confirm';
  ctx.replies.push(reply(L.confirm(clinic, { name: d.name, date: d.date, time: d.time }, s, today), L.confirmButtons()));
  return finish(ctx);
}

function onCancelConfirm(ctx, text, buttonId) {
  const { conv, L, events } = ctx;
  const b = db.getBooking(conv.data.booking_id);
  if (buttonId === 'yes' || P.isYes(text)) {
    b.status = 'cancelled'; const u = db.updateBooking(b);
    events.push({ type: 'booking_cancelled', booking: u });
    conv.data = {}; conv.step = 'idle'; ctx.replies.push(reply(L.cancelled(u))); return finish(ctx);
  }
  conv.data = {}; conv.step = 'menu'; ctx.replies.push(reply(L.menu(), L.menuButtons())); return finish(ctx);
}

function doHandoff(ctx) {
  const { clinic, conv, L, events } = ctx;
  conv.handoff_until = Date.now() + (clinic.handoff_minutes || 60) * 60000;
  conv.data = { handoff_notified: false }; conv.step = 'idle';
  events.push({ type: 'handoff', phone: ctx.phone, name: conv.name });
  ctx.replies.push(reply(L.handoff(clinic)));
  return finish(ctx);
}

// Build a reminder for a booking (used by the scheduler).
function buildReminder(clinic, booking, hoursBefore) {
  const conv = db.getConversation(clinic.id, booking.phone);
  const lang = conv.lang || clinic.default_language || 'ms';
  const L = M[lang];
  const today = S.todayStr(clinic, nowInstant());
  const s = svc(clinic, booking.service_id);
  conv.last_reminder_booking_id = booking.id; conv.step = 'idle'; conv.data = {};
  db.saveConversation(conv);
  const text = L.reminder(clinic, booking, s, hoursBefore, today);
  db.logMessage(clinic.id, booking.phone, 'out', text);
  const { fmtDate, fmtTime, svcName } = require('./messages');
  const out = hoursBefore >= 12 ? reply(text, L.reminderButtons()) : reply(text);
  // Template parameters for the WhatsApp Cloud API (see README "Message templates"): {{1}}..{{5}}
  out.template = hoursBefore >= 12
    ? { key: 'reminder_24h', lang, params: [booking.name || '', clinic.short_name, fmtDate(booking.date, lang, today), fmtTime(booking.time, lang), svcName(s, lang)] }
    : { key: 'reminder_2h', lang, params: [booking.name || '', clinic.short_name, String(hoursBefore), fmtTime(booking.time, lang), clinic.address] };
  return out;
}

module.exports = { handle, buildReminder, AI };
