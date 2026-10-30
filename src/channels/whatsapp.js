// WhatsApp Business Platform (Cloud API) channel. Zero dependencies — uses global fetch (Node 18+).
//
// Env vars:
//   WHATSAPP_TOKEN            System-user access token from Meta Business
//   WHATSAPP_PHONE_NUMBER_ID  The clinic's phone number ID (not the number itself)
//   WHATSAPP_VERIFY_TOKEN     Any secret string; paste the same into the Meta webhook setup
//   WHATSAPP_API_VERSION      optional, default v21.0
//
// Webhook URL to register in Meta: https://<your-host>/webhook  (subscribe to "messages")

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

function configured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function graph(path, body, method = body === undefined ? 'GET' : 'POST') {
  const url = `https://graph.facebook.com/${API_VERSION}/${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// Setup diagnostics (called from the protected /internal/whatsapp route). Checks the token + phone number, lists the apps
// subscribed to the WhatsApp Business Account (Meta only delivers webhooks to subscribed apps) and, with subscribe=true,
// subscribes this app. Never returns the token itself.
async function diagnose({ wabaId, subscribe = false } = {}) {
  const pid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const out = { configured: configured(), phone_number_id: pid || null, waba_id: wabaId || null };
  const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out[key] = { error: e.message }; } };
  if (!out.configured) return out;
  await attempt('phone', () => graph(`${pid}?fields=id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,name_status`));
  if (!wabaId) {
    // Resolve the WABA that owns this phone number via the token's business assets, if possible.
    await attempt('waba_lookup', async () => {
      const r = await graph(`${pid}?fields=whatsapp_business_account`).catch(() => null);
      return r && r.whatsapp_business_account ? r.whatsapp_business_account : { note: 'pass ?waba=<WABA_ID> to check subscriptions' };
    });
    wabaId = out.waba_lookup && out.waba_lookup.id;
    out.waba_id = wabaId || null;
  }
  if (wabaId) {
    await attempt('subscribed_apps_before', () => graph(`${wabaId}/subscribed_apps`));
    if (subscribe) {
      await attempt('subscribe_result', () => graph(`${wabaId}/subscribed_apps`, {}));
      await attempt('subscribed_apps_after', () => graph(`${wabaId}/subscribed_apps`));
    }
    await attempt('phone_numbers_on_waba', () => graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,platform_type`));
  }
  return out;
}

// Meta template language codes for the bot's languages.
const TEMPLATE_LANG = { ms: 'ms', en: 'en', zh: 'zh_CN' };

// Send a pre-approved template (required for any message sent >24h after the patient's last message, e.g. reminders).
// Template name comes from env: WHATSAPP_TEMPLATE_REMINDER_24H / WHATSAPP_TEMPLATE_REMINDER_2H. Buttons are defined on the
// template in Meta as quick replies; their payloads must be rem_yes / rem_resched / rem_cancel.
async function sendTemplate(to, { name, lang = 'en', bodyParams = [], buttons = [] }) {
  const pid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const components = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: String(p).replace(/\s+/g, ' ').slice(0, 1024) })) });
  buttons.forEach((b, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: b.id }] }));
  return graph(`${pid}/messages`, { messaging_product: 'whatsapp', to: normalizePhone(to), type: 'template', template: { name, language: { code: lang }, components } });
}

// Send one bot reply ({text, buttons?, template?}). Buttons (<=3) become interactive reply buttons.
async function send(to, message) {
  const pid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: normalizePhone(to) };
  if (message.template) {
    const tname = process.env['WHATSAPP_TEMPLATE_' + String(message.template.key).toUpperCase()];
    if (tname) return sendTemplate(to, { name: tname, lang: TEMPLATE_LANG[message.template.lang] || 'en', bodyParams: message.template.params || [], buttons: message.buttons || [] });
    // No template configured: fall through to free text (works only inside the 24h window).
  }
  if (message.buttons && message.buttons.length && message.buttons.length <= 3) {
    return graph(`${pid}/messages`, {
      ...base, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.text.slice(0, 1024) },
        action: { buttons: message.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  }
  return graph(`${pid}/messages`, { ...base, type: 'text', text: { preview_url: true, body: message.text.slice(0, 4096) } });
}

async function markRead(messageId) {
  const pid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return graph(`${pid}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
}

// Parse an inbound webhook payload into [{from, text, buttonId, messageId, name}]
function parseInbound(payload) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const contactName = v.contacts && v.contacts[0] && v.contacts[0].profile ? v.contacts[0].profile.name : null;
      for (const m of v.messages || []) {
        let text = null, buttonId = null;
        if (m.type === 'text') text = m.text && m.text.body;
        else if (m.type === 'interactive') {
          const i = m.interactive || {};
          if (i.type === 'button_reply') { buttonId = i.button_reply.id; text = i.button_reply.title; }
          if (i.type === 'list_reply') { buttonId = i.list_reply.id; text = i.list_reply.title; }
        } else if (m.type === 'button') { text = m.button && m.button.text; buttonId = m.button && m.button.payload; }
        else if (m.type === 'image' || m.type === 'document') text = '[attachment]';
        else continue;
        out.push({ from: m.from, text, buttonId, messageId: m.id, name: contactName });
      }
    }
  }
  return out;
}

function normalizePhone(p) { return String(p).replace(/[^\d]/g, ''); }

// Webhook verification handshake (GET /webhook)
function verify(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return query['hub.challenge'];
  return null;
}

module.exports = { configured, send, sendTemplate, markRead, parseInbound, verify, normalizePhone, diagnose, TEMPLATE_LANG };
