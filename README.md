# KlinikBot — WhatsApp booking assistant for clinics (BM + EN + 中文)

A WhatsApp bot that books appointments, offers only free slots, sends 24h and 2h reminders with one-tap confirm, handles reschedule/cancel, answers hours/location/price questions, and hands off to staff on request. Built for Malaysian clinics: replies in Bahasa Melayu, English or Chinese, understands "esok petang", "Sabtu depan 10am", "30/10", "next Monday 3pm", "明天下午", "下周三早上10点", "11月5日".

**Zero dependencies.** Runs on Node 22+ using only built-in modules (`node:http`, `node:sqlite`), or on **Cloudflare Workers (free tier)** via `src/worker.js`. No `npm install` for the Node server.

## Run the demo (no WhatsApp needed)

```bash
node src/server.js
# open http://localhost:3000
```

Or open `dist/klinikbot-demo.html` directly in any browser — the whole engine runs client-side. Rebuild it after changing the engine:

```bash
node scripts/build-standalone.js
```

## Run the tests

```bash
node --test test/engine.test.js
```

## Go live on WhatsApp — step by step

Each clinic = one WhatsApp number + one config file in `clinics/` + one running copy of this server. Do it once for yourself with Meta's free test number, then repeat per clinic.

### Step 1 — Put the server online (15 min) — Cloudflare, free

Cloudflare Workers' free plan covers a clinic many times over (100,000 requests a day; a busy clinic uses a few hundred). The bot runs as a Worker with a Durable Object holding the clinic's SQLite database and a free cron trigger sending reminders every minute. No card needed for the free plan.

**Option A — no terminal (recommended):**
1. Put this folder in a **private GitHub repo** (github.com → New repository → upload files, or drag the folder in GitHub Desktop).
2. dash.cloudflare.com → sign up (free) → **Workers & Pages → Create → Import a repository** → pick the repo → leave build command empty, deploy command `npx wrangler deploy` → **Deploy**. First deploy takes ~2 minutes and gives you `https://klinikbot.<your-subdomain>.workers.dev`.
3. Worker → **Settings → Variables and Secrets** → add:
   - `WHATSAPP_VERIFY_TOKEN` (secret) — any long random string you make up
   - `WHATSAPP_TOKEN` (secret) — from Step 3
   - `WHATSAPP_PHONE_NUMBER_ID` — from Step 2
   - `ANTHROPIC_API_KEY` (secret) — optional, Step 6
   - `INTERNAL_TOKEN` (secret) — any random string (protects the reminder endpoint)
   - `CLINIC`, `WHATSAPP_TEMPLATE_REMINDER_24H/2H` are already in `wrangler.toml`; override here per clinic if needed.
4. Open `https://…workers.dev/health` → `{"ok":true,…}`. Open `/` → the demo page. Every push to GitHub redeploys automatically.

**Option B — terminal:** `npx wrangler login` → `npx wrangler deploy` → `npx wrangler secret put WHATSAPP_TOKEN` (repeat per secret).

**Per clinic:** add their config file to `clinics/` and one line in `CLINICS` in `src/worker.js`, then deploy a second Worker with `CLINIC=<their-id>` (dashboard → Settings → Variables), or duplicate the repo. Each Worker has its own URL to register in Meta.

**Alternative hosts (paid, a few USD/month):** Railway / Fly.io / Render run `node src/server.js` with a persistent disk for `DATA_DIR`; set the same variables. Use these only if you outgrow the free tier.

### Step 2 — Create the Meta app (20 min, free)
1. business.facebook.com → create a **Business Portfolio** (your own company; clinics are added under it later, or they use their own).
2. developers.facebook.com → **My Apps → Create App → Other → Business** → name it (e.g. "KlinikBot") → attach your Business Portfolio.
3. In the app dashboard: **Add product → WhatsApp → Set up.** Meta gives you a **free test number** that can message up to 5 phone numbers you register. Use this first.
4. On **WhatsApp → API Setup** note the **Phone number ID** (a long number — NOT the phone number). Put it in `WHATSAPP_PHONE_NUMBER_ID`.
5. Add your own mobile under "To" recipients and send the test message from that page to confirm it arrives.

### Step 3 — Permanent token (5 min)
The token on the API Setup page expires in 24h. Make a permanent one:
business.facebook.com → **Settings → Users → System users → Add** (name "klinikbot", role Admin) → **Add assets** → your app → Full control → **Generate new token** → tick `whatsapp_business_messaging` and `whatsapp_business_management` → copy it into `WHATSAPP_TOKEN`. Redeploy.

### Step 4 — Connect the webhook (5 min)
App dashboard → **WhatsApp → Configuration → Webhook → Edit**:
- Callback URL: `https://<your-url>/webhook`
- Verify token: the same `WHATSAPP_VERIFY_TOKEN` you set
- Save → then **Manage** → subscribe to **messages**.

Now WhatsApp "hai" to the test number from your phone. The bot should reply with the menu within 2 seconds. Check the server logs if not.

### Step 5 — Message templates (10 min + approval, usually minutes to a few hours)
WhatsApp rule: a business may send free-form text only within **24 hours after the patient's last message**. Reminders go out a day later, so they must be approved **templates**. Create these in **WhatsApp Manager → Message templates → Create**, category **Utility**, one per language the clinic uses (Malay = `ms`, English = `en`, Chinese = `zh_CN`). Names must match the env vars.

**Template `appt_reminder_24h`** — body (English version; translate for ms / zh_CN keeping the same {{n}} order):
```
Hi {{1}}, reminder of your appointment at {{2}} on {{3}} at {{4}} for {{5}}. Can you make it?
```
Sample values for review: `Sarah Lim` · `Klinik Sinar` · `Tomorrow (Thu, 29 Oct)` · `2pm` · `Check-up & Scaling`
Buttons → **Quick reply** ×3, in this order, with these payloads (the bot reads the payload):
1. `Yes, I'll be there` — payload `rem_yes`
2. `Reschedule` — payload `rem_resched`
3. `Cancel` — payload `rem_cancel`

Malay body: `Hai {{1}}, peringatan temujanji anda di {{2}} pada {{3}} jam {{4}} untuk {{5}}. Boleh datang?` Buttons: `Ya, saya datang` / `Tukar masa` / `Batal`.
Chinese body: `{{1}}您好，提醒您在{{2}}的预约：{{3}} {{4}}，项目：{{5}}。请问能准时到吗？` Buttons: `可以，我会到` / `更改时间` / `取消`.

**Template `appt_reminder_2h`** — body, no buttons:
```
Hi {{1}}, your appointment at {{2}} is in {{3}} hours ({{4}}). Address: {{5}}. See you soon!
```
Malay: `Hai {{1}}, temujanji anda di {{2}} adalah dalam {{3}} jam lagi ({{4}}). Alamat: {{5}}. Jumpa nanti!`
Chinese: `{{1}}您好，您在{{2}}的预约还有{{3}}小时（{{4}}）。地址：{{5}}。到时见！`

Until templates are approved, the bot still works for everything inside the 24h window (booking, questions, same-day changes); only the next-day reminder would fail, and the log will show the Meta error.

### Step 6 — AI answers (2 min)
Create an API key in the Claude Console (console.anthropic.com) → set `ANTHROPIC_API_KEY` → redeploy. `/health` shows `"ai":true`. Without it, unknown questions get the scripted menu.

### Step 7 — The clinic's real number (per clinic)
1. Copy `clinics/demo-dental.json` → `clinics/<clinic-id>.json`, fill in their details, services, prices, hours, DuitNow link, and `ai.knowledge` facts. Set `CLINIC=<clinic-id>` on that clinic's deployment.
2. In the Meta app: **WhatsApp → API Setup → Add phone number**. The number must **not** be active on the WhatsApp / WhatsApp Business app, unless you enable **Coexistence** (lets the clinic keep using the Business App on the same number while the bot handles the API side — recommended for clinics that already chat with patients). Verify by SMS.
3. Use that number's **Phone number ID** in the clinic's deployment.
4. **Business verification** (Meta → Business Settings → Security Centre): upload the clinic's SSM certificate. Unverified accounts have a small daily limit of new contacts; verified ones scale up automatically with good message quality. Start it on day one — it takes a few days.
5. Set the clinic's display name and profile photo under **Phone numbers → Profile**.

### Step 8 — Hand-over checklist
- Patient books on WhatsApp → appears in the clinic's dashboard at `https://<url>/`.
- Next-day reminder arrives as a template with 3 buttons; tapping "Yes" marks the booking patient-confirmed.
- "cakap dengan staf" pauses the bot for 60 min and (if you forward `handoff` events) alerts `staff_whatsapp`.
- Clinic knows: type `menu` to bring the bot back for a patient; deposits are checked manually from the receipt screenshot.

### Costs you pass through to the clinic
- Hosting: free on Cloudflare Workers for a clinic's volume; a few USD/month if you move to Railway/Fly later.
- Meta: utility messages (reminders) cost a few sen each in Malaysia; replies to patient-initiated chats within 24h are free. ~300 reminders/month ≈ RM20.
- Claude API: fractions of a sen per answered question. Check current pricing at docs.claude.com.

## Turn on AI answers (Claude)

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, default `claude-haiku-5-5`). Claude then answers free-text questions — "scaling sakit tak?", "ada parking?", "panel insurans?" — in BM, English or Manglish, using **only** the facts in the clinic's config (`services`, `hours`, `deposit`, and `ai.knowledge`). Bookings, slots, reminders and cancellations stay with the deterministic engine; Claude hands over with an `<action>book</action>` / `manage` / `handoff` tag. It is instructed never to diagnose, never to state availability, and to pass to staff when it does not know.

Without the key the bot still works; it just falls back to the scripted menu for anything it does not understand.

Cost: each AI reply is one short API call (about 1,500 input tokens of clinic facts + a 2-sentence answer). Check current per-token pricing at docs.claude.com and bundle it into the monthly fee.

Add clinic-specific facts in `clinics/<id>.json` under `ai.knowledge` (one plain sentence per fact: dentists, parking, payment methods, insurance, kids, pregnancy, MC policy, languages, emergencies).

## Configure a clinic

Copy `clinics/demo-dental.json` → `clinics/<clinic-id>.json` and edit: name (BM/EN/中文), address, Waze link, opening hours per day, lunch break, slot length, services (BM/EN/中文 names, duration, price-from), deposit (on/off, amount, DuitNow link), reminder timings, staff WhatsApp for handoff alerts.

## Layout

```
src/
  app.js                 the HTTP routes (web-standard Request/Response) shared by Node and Cloudflare
  server.js              Node runner: http bridge + reminder timer
  worker.js              Cloudflare Workers runner: Durable Object per clinic + cron trigger for reminders
  engine/
    conversation.js      state machine: book / reschedule / cancel / info / handoff / reminder replies
    ai.js                Claude layer: clinic-knowledge prompt, action tags, Anthropic API transport
    parser.js            BM+EN understanding: intents, dates, times, services, names
    messages.js          all bot copy in both languages
    scheduling.js        timezone-safe slots and availability
  channels/whatsapp.js   Meta Cloud API send/receive (text + interactive buttons)
  reminders.js           every-minute scheduler for 24h / 2h reminders
  store/index.js         store registry (binds the right store per request)
  store/db.js            SQLite (node:sqlite) for the Node server
  store/db-do.js         Durable Object SQLite for Cloudflare
  store/memory.js        in-memory store used by the standalone demo
wrangler.toml            Cloudflare config (assets, Durable Object, cron)
public/demo.html         sales demo: phone chat + live clinic dashboard
clinics/*.json           one config per clinic
scripts/build-standalone.js   bundles engine + demo into one HTML file (dist/)
test/engine.test.js      end-to-end conversation tests
```

## Roadmap (what to add once the first clinic pays)
- Google Calendar sync for the dentist's own calendar
- Staff dashboard with login (today's list, mark done / no-show, broadcast)
- Post-visit review request and recall reminders (6-month scaling)
