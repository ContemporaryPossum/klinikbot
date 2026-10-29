// AI layer: Claude answers free-form questions as the clinic's assistant, using only the clinic's own
// knowledge, and hands structured intents (book / manage / staff) back to the deterministic engine.
//
// The transport is injected so the same code runs on the server (Anthropic API) and in the browser demo
// (the artifact "sample" capability):   setCompleter(async (system, messages) => text)

let completer = null;
function setCompleter(fn) { completer = typeof fn === 'function' ? fn : null; }
function available() { return !!completer; }

// ---- question detection (decides when to consult the AI instead of re-asking the script's prompt) ----
const Q_WORDS = /\b(apa|apakah|kenapa|mengapa|macam ?mana|bagaimana|boleh ?(ke|tak|x)|bolehkah|adakah|ada ?(ke|tak|x)\b|berapa|bila|siapa|mana|perlu ?(ke|tak)|kena ?(ke|tak)|sakit ?(ke|tak|x)|selamat ?(ke|tak)|what|why|how|can i|can you|could|should|is it|is there|are there|do you|does|will|would|which|where|when|who|any|got)\b/i;
function looksLikeQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.includes('?')) return true;
  if (Q_WORDS.test(t) && t.split(/\s+/).length >= 2) return true;
  return false;
}

// ---- knowledge prompt ----
function fmtHours(c) {
  const names = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  return Object.entries(names).map(([k, n]) => `${n}: ${c.hours[k] ? c.hours[k].join('–') : 'closed'}`).join(', ') + (c.lunch ? `; lunch break ${c.lunch.join('–')}` : '');
}

function buildSystem(clinic, conv) {
  const c = clinic;
  const ai = c.ai || {};
  const persona = ai.persona || 'the clinic assistant';
  const lang = conv && conv.lang === 'en' ? 'English' : conv && conv.lang === 'zh' ? 'Chinese (简体中文)' : 'Bahasa Melayu';
  const services = c.services.map(s => `- ${s.en} / ${s.ms}${s.zh ? ' / ' + s.zh : ''} (id: ${s.id}): ${s.price_from ? `from RM${s.price_from}` : 'free consultation'}, about ${s.duration} min`).join('\n');
  const faq = (ai.knowledge || []).map(k => `- ${k}`).join('\n');
  return `You are ${persona}, the WhatsApp assistant for ${c.name.en} (${c.name.ms}), a dental clinic in Malaysia. You are NOT a dentist.

CLINIC FACTS (the only facts you may state):
- Address: ${c.address}
- Waze: ${c.waze_url}
- Phone: ${c.phone}
- Hours: ${fmtHours(c)}
- Bookings: up to ${c.max_days_ahead || 14} days ahead, ${c.slot_minutes}-minute slots
${c.deposit && c.deposit.enabled ? `- Deposit: RM${c.deposit.amount} via DuitNow to lock a slot; it is deducted from the treatment bill` : '- No deposit required'}
- Services and price guide (final price depends on the dentist's examination):
${services}
${faq ? `- Other facts:\n${faq}` : ''}

HOW TO REPLY:
- Write like a friendly, efficient clinic receptionist on WhatsApp: 1–3 short sentences, warm, no fluff. Match the patient's language and style — Bahasa Melayu, English, Manglish/rojak, or Chinese (the patient's current preference is ${lang}). For Chinese use simplified characters and natural Malaysian-Chinese phrasing (e.g. 洗牙, 补牙, 拔牙, 预约).
- Plain text only. You may use *bold* for a price or a time. No bullet lists unless listing 3+ prices. No markdown headings, no emojis beyond one at most.
- Only state facts from CLINIC FACTS. If you do not know something (insurance panels, a specific dentist, parking, a price not listed, a medical question that needs a dentist), say you will check with the clinic staff — do not guess.
- Medical questions: give short general reassurance and practical guidance only (e.g. scaling is usually painless, mild sensitivity afterwards is normal). Never diagnose, never prescribe, never give dosages. Recommend the dentist examine them. For severe pain, swelling, bleeding that will not stop, or trauma: tell them to call the clinic now or go to the nearest hospital emergency department.
- You CANNOT see the appointment calendar. Never state or imply that a date or time is available or booked. Never confirm a booking yourself.
- Stay on the clinic's topics. If asked something unrelated, answer in one friendly line and steer back to how you can help with their dental visit.
- Always end with a light nudge toward the next step when natural (e.g. "Nak saya bantu tempah slot?").

ACTIONS — when the patient's message shows one of these intents, put exactly one tag on its own last line, after your reply text:
- They want to make an appointment (even just "ok", "ya", "boleh" after you offered): <action>book</action> or, if the treatment is clear, <action>book:SERVICE_ID</action> using an id from the services list.
- They want to change or cancel an existing appointment: <action>manage</action>
- They ask for a human, a specific dentist, a call, or you cannot help: <action>handoff</action>
Otherwise add no tag. The system will take over the booking the moment you emit the tag, so when you emit <action>book…</action> keep your text to one short sentence like "Boleh! Saya bantu tempahkan." and do not ask for date or time yourself.`;
}

// ---- history → turns ----
function historyTurns(messages, limit = 8) {
  const turns = [];
  for (const m of messages.slice(-limit)) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const content = String(m.text || '').trim();
    if (!content) continue;
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += '\n' + content;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

const ACTION_RE = /<action>\s*([a-z]+)(?::([a-z0-9_-]+))?\s*<\/action>/i;

// Returns { text, action: {type, service_id?} | null } or null when the AI is unavailable / failed.
async function answer(clinic, conv, recentMessages, userText, { log } = {}) {
  if (!completer) return null;
  const system = buildSystem(clinic, conv);
  const prior = historyTurns(recentMessages.filter(m => m.text !== userText || m.direction !== 'in'));
  const messages = [...prior, { role: 'user', content: userText }];
  try {
    const raw = await completer(system, messages, { clinic, conv });
    if (!raw || !String(raw).trim()) return null;
    let text = String(raw).trim();
    let action = null;
    const m = text.match(ACTION_RE);
    if (m) {
      action = { type: m[1].toLowerCase(), service_id: m[2] || null };
      text = text.replace(ACTION_RE, '').trim();
    }
    // strip any markdown the model slipped in
    text = text.replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '*$1*');
    return { text, action };
  } catch (e) {
    if (log && log.error) log.error('[ai]', e && e.message || e);
    return null;
  }
}

// ---- server-side transport: Anthropic Messages API via fetch (no SDK) ----
function anthropicCompleter({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', maxTokens = 350 } = {}) {
  if (!apiKey) return null;
  return async (system, messages) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  };
}

module.exports = { setCompleter, available, looksLikeQuestion, buildSystem, historyTurns, answer, anthropicCompleter };
