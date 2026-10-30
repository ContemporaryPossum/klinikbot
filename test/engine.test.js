// Drives full conversations through the engine in BM and EN. Run: node --test test/
process.env.DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const clinic = require(path.join(__dirname, '..', 'clinics', 'demo-dental.json'));
const { handle, buildReminder } = require('../src/engine/conversation');
const db = require('../src/store/db');
require('../src/store').use(db);
const S = require('../src/engine/scheduling');

async function chat(phone, text, buttonId) {
  const out = await handle(clinic, phone, { text, buttonId }, { source: 'test' });
  return { text: out.replies.map(r => r.text).join('\n---\n'), events: out.events, replies: out.replies };
}

test('BM: book scaling tomorrow afternoon in one message', async () => {
  db.resetPhone(clinic.id, '601');
  let r = await chat('601', 'nak scaling esok petang');
  assert.match(r.text, /Slot kosong|Slot lain yang ada|penuh|Sabtu|Isnin|tutup/i);
  // find a numbered slot (tomorrow may be a half-day: the bot then offers the other slots of that day)
  if (/Slot kosong|Slot lain yang ada/.test(r.text)) {
    r = await chat('601', '1');
    assert.match(r.text, /nama/i);
    r = await chat('601', 'Ahmad Faiz');
    assert.match(r.text, /Sila semak/);
    r = await chat('601', 'ya');
    assert.match(r.text, /Tempahan disahkan/);
    assert.ok(r.events.some(e => e.type === 'booking_created'));
    assert.match(r.text, /Deposit RM50/i);
  }
});

test('EN: menu-driven booking with explicit date and time', async () => {
  db.resetPhone(clinic.id, '602');
  let r = await chat('602', 'hello');
  assert.match(r.text, /Welcome|Selamat datang/);
  r = await chat('602', 'english');
  r = await chat('602', '1');
  assert.match(r.text, /What treatment/);
  r = await chat('602', 'filling');
  assert.match(r.text, /When would you like/);
  // pick a weekday that's open: next Monday
  r = await chat('602', 'next monday');
  assert.match(r.text, /Available slots/);
  r = await chat('602', '10am');
  assert.match(r.text, /full name/);
  r = await chat('602', 'my name is sarah lim');
  assert.match(r.text, /Sarah Lim/);
  r = await chat('602', 'yes');
  assert.match(r.text, /Booking confirmed/);
  const b = r.events.find(e => e.type === 'booking_created').booking;
  assert.strictEqual(b.time, '10:00');
  assert.strictEqual(b.name, 'Sarah Lim');
});

test('Double-booking is prevented', async () => {
  db.resetPhone(clinic.id, '603');
  db.resetPhone(clinic.id, '604');
  const today = S.todayStr(clinic);
  const date = S.nextOpenDates(clinic, S.addDays(today, 1), 1)[0];
  let r = await chat('603', `checkup ${date.split('-').reverse().slice(0, 2).join('/')} 11am`);
  r = await chat('603', 'Ali');
  r = await chat('603', 'yes');
  assert.match(r.text, /confirmed|disahkan/);
  r = await chat('604', `checkup ${date.split('-').reverse().slice(0, 2).join('/')} 11am`);
  assert.match(r.text, /taken|diambil/i);
});

test('Cancel flow', async () => {
  db.resetPhone(clinic.id, '605');
  let r = await chat('605', 'book checkup tomorrow');
  // tomorrow might be closed (Sunday) -> pick option 1
  if (/closed|tutup|fully|penuh/i.test(r.text)) r = await chat('605', '1');
  r = await chat('605', '1');
  r = await chat('605', 'Mei Ling');
  r = await chat('605', 'yes');
  assert.match(r.text, /confirmed|disahkan/);
  r = await chat('605', 'cancel my appointment');
  assert.match(r.text, /Cancel your appointment|Batal temujanji/);
  r = await chat('605', 'yes');
  assert.match(r.text, /cancelled|dibatalkan/);
  assert.ok(r.events.some(e => e.type === 'booking_cancelled'));
});

test('Reminder quick-reply confirms attendance', async () => {
  db.resetPhone(clinic.id, '606');
  let r = await chat('606', 'nak cabut gigi sabtu');
  if (/tutup|penuh/i.test(r.text)) r = await chat('606', '1');
  r = await chat('606', '1');
  r = await chat('606', 'Hafiz');
  r = await chat('606', 'ya');
  const b = r.events.find(e => e.type === 'booking_created').booking;
  const rem = buildReminder(clinic, b, 24);
  assert.match(rem.text, /Peringatan/);
  assert.ok(rem.buttons && rem.buttons.length === 3);
  r = await chat('606', '1');
  assert.match(r.text, /Jumpa esok/);
  assert.strictEqual(db.getBooking(b.id).patient_confirmed, 1);
});

test('Hours, price, and staff handoff', async () => {
  db.resetPhone(clinic.id, '607');
  let r = await chat('607', 'what time do you open');
  assert.match(r.text, /Opening hours/);
  r = await chat('607', 'how much for whitening');
  assert.match(r.text, /Price guide/);
  r = await chat('607', 'can i talk to a staff');
  assert.match(r.text, /notified the clinic staff/);
  assert.ok(r.events.some(e => e.type === 'handoff'));
  r = await chat('607', 'hello?');
  assert.match(r.text, /staff will reply/);
  r = await chat('607', 'menu');
  assert.match(r.text, /Choose one/);
});

// ---------------- AI layer (mocked Claude) ----------------
const { AI } = require('../src/engine/conversation');

test('AI: free question answered, then "ya" triggers booking via action tag', async () => {
  db.resetPhone(clinic.id, '701');
  const calls = [];
  AI.setCompleter(async (system, messages) => {
    calls.push({ system, messages });
    const last = messages[messages.length - 1].content.toLowerCase();
    if (/sakit/.test(last)) return 'Scaling biasanya tak sakit, cuma rasa sedikit ngilu sahaja. Nak saya bantu tempah slot?';
    if (/^(ya|ok)/.test(last)) return 'Boleh! Saya bantu tempahkan.\n<action>book:checkup</action>';
    return 'Baik.';
  });
  try {
    let r = await chat('701', 'scaling sakit tak?');
    assert.match(r.text, /tak sakit/);
    assert.ok(calls[0].system.includes('Klinik Pergigian Sinar'));
    assert.ok(calls[0].system.includes('Parking'));
    assert.ok(r.events.some(e => e.type === 'ai_answered'));
    r = await chat('701', 'ya');
    assert.match(r.text, /Boleh! Saya bantu tempahkan/);
    assert.match(r.text, /Bila anda nak datang/);          // engine took over at the date step (service prefilled)
    assert.ok(!/<action>/.test(r.text));
    assert.ok(calls[1].messages.length >= 3);                // history was passed
  } finally { AI.setCompleter(null); }
});

test('AI: question mid-booking is answered and the step is re-asked; booking data intact', async () => {
  db.resetPhone(clinic.id, '702');
  AI.setCompleter(async () => 'Ya, parking percuma di hadapan kedai.');
  try {
    let r = await chat('702', 'nak tampal gigi');
    assert.match(r.text, /Bila anda nak datang/);
    r = await chat('702', 'ada parking tak?');
    assert.match(r.text, /parking percuma/);
    assert.match(r.text, /Bila anda nak datang|esok|Sabtu/i);
    r = await chat('702', '1');
    assert.match(r.text, /Slot kosong/);                      // still in the booking flow, service remembered
  } finally { AI.setCompleter(null); }
});

test('AI: handoff action pauses the bot; AI failure falls back to the script', async () => {
  db.resetPhone(clinic.id, '703');
  AI.setCompleter(async () => 'Saya semak dengan staf ya.\n<action>handoff</action>');
  try {
    let r = await chat('703', 'boleh jumpa Dr Farah khamis ni?');
    assert.match(r.text, /maklumkan staf/);
    assert.ok(r.events.some(e => e.type === 'handoff'));
  } finally { AI.setCompleter(null); }
  db.resetPhone(clinic.id, '704');
  AI.setCompleter(async () => { throw new Error('boom'); });
  try {
    const r = await chat('704', 'korang panel AIA ke?');
    assert.match(r.text, /tak faham|menu/i);                  // scripted fallback, no crash
  } finally { AI.setCompleter(null); }
});

test('AI off: behaviour unchanged (price list is scripted)', async () => {
  db.resetPhone(clinic.id, '705');
  const r = await chat('705', 'berapa harga scaling?');
  assert.match(r.text, /Anggaran harga/);
});

test('AI: "boleh buat scaling esok petang?" → AI answers, booking keeps the date and time hints', async () => {
  db.resetPhone(clinic.id, '706');
  AI.setCompleter(async () => 'Boleh! Saya bantu tempahkan.\n<action>book:checkup</action>');
  try {
    const r = await chat('706', 'boleh buat scaling esok petang?');
    assert.match(r.text, /Boleh! Saya bantu tempahkan/);
    assert.match(r.text, /Slot kosong|Slot lain yang ada|penuh|tutup/);           // jumped straight to time selection for tomorrow
  } finally { AI.setCompleter(null); }
});

// ---------------- Chinese (中文) ----------------
test('ZH: full booking in Chinese in one message, name in Chinese, confirm with 是', async () => {
  db.resetPhone(clinic.id, '801');
  let r = await chat('801', '我要明天下午洗牙');
  assert.match(r.text, /可预约的时间|已约满|休息/);
  const afternoonOffered = !/其他可预约/.test(r.text);   // tomorrow may be a half-day with no afternoon slots
  if (/可预约的时间/.test(r.text)) {
    r = await chat('801', '第1个');
    assert.match(r.text, /姓名/);
    r = await chat('801', '我叫陈美玲');
    assert.match(r.text, /请确认您的预约/); assert.match(r.text, /陈美玲/); assert.match(r.text, /检查与洗牙/);
    r = await chat('801', '是');
    assert.match(r.text, /预约成功/); assert.match(r.text, /订金/);
    const b = r.events.find(e => e.type === 'booking_created').booking;
    assert.strictEqual(b.name, '陈美玲');
    if (afternoonOffered) assert.ok(Number(b.time.slice(0, 2)) >= 12);           // 下午 → afternoon slot
  }
});

test('ZH: menu, hours, price, staff handoff, and language switch mid-chat', async () => {
  db.resetPhone(clinic.id, '802');
  let r = await chat('802', '你好');
  assert.match(r.text, /欢迎来到/); assert.match(r.text, /请选择/);
  r = await chat('802', '你们几点开门');
  assert.match(r.text, /营业时间/); assert.match(r.text, /周一至周五/);
  r = await chat('802', '洗牙多少钱');
  assert.match(r.text, /价格参考/); assert.match(r.text, /RM80起/);
  r = await chat('802', '我要找真人');
  assert.match(r.text, /已通知诊所前台/);
  assert.ok(r.events.some(e => e.type === 'handoff'));
  r = await chat('802', '菜单');
  assert.match(r.text, /请选择/);
  r = await chat('802', 'english');
  assert.match(r.text, /reply in English/);
  r = await chat('802', '中文');
  assert.match(r.text, /用中文回复/);
});

test('ZH: reschedule with 下周三 and cancel flow', async () => {
  db.resetPhone(clinic.id, '803');
  let r = await chat('803', '预约补牙');
  r = await chat('803', '1');
  r = await chat('803', '1');
  r = await chat('803', '王小明');
  r = await chat('803', '确认');
  assert.match(r.text, /预约成功/);
  r = await chat('803', '我要改时间');
  assert.match(r.text, /哪一天方便/);
  r = await chat('803', '下周三');
  assert.match(r.text, /可预约的时间/);
  r = await chat('803', '早上10点');
  assert.match(r.text, /请确认您的预约/); assert.match(r.text, /上午10点/);
  r = await chat('803', '是');
  assert.match(r.text, /预约已更改/);
  assert.ok(r.events.some(e => e.type === 'booking_rescheduled'));
  r = await chat('803', '取消预约');
  assert.match(r.text, /确定取消/);
  r = await chat('803', '是');
  assert.match(r.text, /已取消/);
});

test('ZH: reminder and quick reply', async () => {
  db.resetPhone(clinic.id, '804');
  let r = await chat('804', '拔牙 星期六');
  if (/休息|约满/.test(r.text)) r = await chat('804', '1');
  r = await chat('804', '1');
  r = await chat('804', '林志强');
  r = await chat('804', '好的');
  const b = r.events.find(e => e.type === 'booking_created').booking;
  const rem = buildReminder(clinic, b, 24);
  assert.match(rem.text, /预约提醒/); assert.match(rem.text, /林志强/);
  r = await chat('804', '可以，我会到');
  assert.match(r.text, /明天见/);
  assert.strictEqual(db.getBooking(b.id).patient_confirmed, 1);
});

test('Opt-out: "stop" switches off reminders for upcoming bookings (BM/EN/ZH)', async () => {
  db.resetPhone(clinic.id, '690');
  const b = db.createBooking({ clinic_id: clinic.id, phone: '690', name: 'Opt Out', service_id: 'checkup', date: '2031-03-04', time: '10:00', duration: 30, source: 'test' });
  let r = await chat('690', 'stop');
  assert.match(r.text, /reminders .* off|peringatan .* dimatikan/i);
  assert.ok(r.events.some(e => e.type === 'reminders_off'));
  assert.deepStrictEqual(db.getBooking(b.id).reminders_sent.sort(), [2, 24]);
  const S2 = require('../src/engine/scheduling');
  const R = require('../src/reminders');
  const sent = await R.runOnce(clinic, async () => { throw new Error('should not send'); }, { info() {}, error() {} }, S2.toInstant('2031-03-03', '10:30', clinic.timezone));
  assert.strictEqual(sent.filter(s => s.booking_id === b.id).length, 0);
  db.resetPhone(clinic.id, '691');
  r = await chat('691', '停止提醒');
  assert.match(r.text, /提醒已关闭/);
  db.resetPhone(clinic.id, '692');
  r = await chat('692', 'berhenti');
  assert.match(r.text, /dimatikan/);
});
