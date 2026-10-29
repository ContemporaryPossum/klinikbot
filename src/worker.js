// Cloudflare Workers entry (free tier). One Worker = one clinic.
// - Requests are forwarded to a Durable Object (one per clinic) that owns the clinic's SQLite database.
// - A cron trigger (every minute) asks the DO to send due reminders.
// Config: wrangler.toml. Secrets: `npx wrangler secret put WHATSAPP_TOKEN` etc., or the dashboard.
import { DurableObject } from 'cloudflare:workers';
const store = require('./store');
const { createStore } = require('./store/db-do');
const { handleRequest } = require('./app');
const { AI } = require('./engine/conversation');
const whatsapp = require('./channels/whatsapp');

// Clinic configs are bundled in; CLINIC env var picks one.
const CLINICS = {
  'demo-dental': require('../clinics/demo-dental.json'),
};

function applyEnv(env) {
  // The channel/AI modules read process.env; mirror the Worker's env into it.
  if (typeof process === 'undefined') globalThis.process = { env: {} };
  if (!process.env) process.env = {};
  for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_API_VERSION', 'WHATSAPP_TEMPLATE_REMINDER_24H', 'WHATSAPP_TEMPLATE_REMINDER_2H', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'])
    if (env[k] !== undefined) process.env[k] = env[k];
  AI.setCompleter(AI.anthropicCompleter());
}

export class ClinicDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = createStore(ctx.storage.sql);
    this.log = { info: (...a) => console.log(...a), error: (...a) => console.error(...a) };
  }
  async fetch(request) {
    applyEnv(this.env);
    const clinicId = this.env.CLINIC || 'demo-dental';
    const clinic = CLINICS[clinicId];
    if (!clinic) return new Response(`Unknown clinic "${clinicId}" — add it to CLINICS in src/worker.js`, { status: 500 });
    const deliverAny = async (phone, message) => { if (whatsapp.configured() && /^\d{8,15}$/.test(phone)) await whatsapp.send(phone, message); };
    const serveStatic = async (path) => {
      if (!this.env.ASSETS) return null;
      const res = await this.env.ASSETS.fetch(new Request(new URL('/' + path, request.url), { method: 'GET' }));
      return res.status === 200 ? res : null;
    };
    const deps = { clinic, db: this.db, whatsapp, deliverAny, log: this.log, serveStatic, env: this.env, waitUntil: p => this.ctx.waitUntil(p) };
    return store.run(this.db, () => handleRequest(request, deps));
  }
}

function stub(env) { return env.CLINIC_DO.get(env.CLINIC_DO.idFromName(env.CLINIC || 'demo-dental')); }

export default {
  async fetch(request, env) { return stub(env).fetch(request); },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(stub(env).fetch(new Request('https://internal/internal/reminders', { method: 'POST', headers: { 'x-internal-token': env.INTERNAL_TOKEN || '' } })));
  },
};
