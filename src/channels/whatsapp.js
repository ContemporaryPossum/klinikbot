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

async function graph(path, body) {
  const url = `https://graph.facebook.com/${API_VERSION}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(json)}`);
  return json;
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

module.exports = { configured, send, sendTemplate, markRead, parseInbound, verify, normalizePhone, TEMPLATE_LANG };
