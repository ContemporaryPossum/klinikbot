// KlinikBot Node server — zero dependencies. Run: node src/server.js
// Serves the sales demo at /  and the WhatsApp webhook at /webhook. (Cloudflare version: src/worker.js)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const store = require('./store');
const db = require('./store/db');
store.use(db);
const { handleRequest } = require('./app');
const { AI } = require('./engine/conversation');
const whatsapp = require('./channels/whatsapp');
const reminders = require('./reminders');

const PORT = Number(process.env.PORT || 3000);
const CLINIC_ID = process.env.CLINIC || 'demo-dental';
const clinic = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'clinics', `${CLINIC_ID}.json`), 'utf8'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const log = { info: (...a) => console.log(new Date().toISOString(), ...a), error: (...a) => console.error(new Date().toISOString(), ...a) };

// Claude answers free-text questions when ANTHROPIC_API_KEY is set (see src/engine/ai.js).
AI.setCompleter(AI.anthropicCompleter());

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return null;
  return new Response(fs.readFileSync(p), { headers: { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' } });
}
const deliverAny = async (phone, message) => { if (whatsapp.configured() && /^\d{8,15}$/.test(phone)) await whatsapp.send(phone, message); };
const deps = { clinic, db, whatsapp, deliverAny, log, serveStatic, env: process.env };

// Bridge Node's http to the web-standard Request/Response used by app.js
const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await handleRequest(request, deps);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    log.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    log.info(`KlinikBot for "${clinic.short_name}" on http://localhost:${PORT}  (WhatsApp: ${whatsapp.configured() ? 'LIVE' : 'not configured — demo mode'}, AI: ${AI.available() ? 'on' : 'off — set ANTHROPIC_API_KEY'})`);
  });
  reminders.start(clinic, deliverAny, { log });
}

module.exports = { server, deps };
