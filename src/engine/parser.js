// Rule-based understanding for Malay (BM), English and Chinese (中文) messages.
// Handles: language detection, intents, dates ("esok", "next monday", "30/10"), times ("3pm", "pukul 3 petang"), services, yes/no.
const { addDays, dowOf, pad } = require('./scheduling');

const norm = s => (s || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff5e\u3000-\u303f]/;
const hasCJK = s => CJK.test(s || '');
// Full-width digits → ASCII; Chinese numerals (一..十二) → digits where they stand alone as a number
const CN_NUM = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
function cnToDigits(s) {
  return (s || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48))
    .replace(/十([一二三四五六七八九])/g, (m, a) => String(10 + CN_NUM[a]))
    .replace(/([一二三四五六七八九])十/g, (m, a) => String(CN_NUM[a] * 10))
    .replace(/十/g, '10')
    .replace(/[零〇一二两三四五六七八九]/g, ch => String(CN_NUM[ch]));
}

// ---------- language ----------
const MS_WORDS = ['saya', 'nak', 'boleh', 'tempah', 'temujanji', 'pukul', 'petang', 'pagi', 'esok', 'lusa', 'hari', 'ini', 'tak', 'tidak', 'ya', 'macam', 'mana', 'bila', 'apa', 'waktu', 'buka', 'tutup', 'alamat', 'gigi', 'klinik', 'batal', 'tukar', 'ubah', 'jam', 'minggu', 'depan', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu', 'ahad', 'malam', 'untuk', 'dengan', 'ada', 'kosong', 'sakit', 'nama', 'terima', 'kasih', 'assalamualaikum', 'salam', 'okey', 'ok', 'kemas', 'kini', 'cakap', 'staf', 'doktor', 'harga', 'berapa'];
const EN_WORDS = ['i', 'want', 'book', 'appointment', 'tomorrow', 'today', 'morning', 'afternoon', 'evening', 'can', 'please', 'what', 'when', 'where', 'time', 'open', 'close', 'address', 'cancel', 'reschedule', 'change', 'next', 'week', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'yes', 'no', 'the', 'is', 'my', 'name', 'thanks', 'hello', 'hi', 'staff', 'doctor', 'price', 'how', 'much', 'tooth', 'teeth', 'pain', 'slot', 'available'];

function detectLanguage(text) {
  const t = norm(text);
  if (/\b(english|in english|eng)\b/.test(t)) return 'en';
  if (/\b(bm|bahasa|melayu|malay)\b/.test(t)) return 'ms';
  if (/中文|华语|华文|chinese|mandarin|汉语/.test(t)) return 'zh';
  if (hasCJK(t)) return 'zh';
  const words = t.split(/[^a-z]+/).filter(Boolean);
  let ms = 0, en = 0;
  for (const w of words) { if (MS_WORDS.includes(w)) ms++; if (EN_WORDS.includes(w)) en++; }
  if (ms === 0 && en === 0) return null;
  if (ms > en) return 'ms';
  if (en > ms) return 'en';
  return null;
}

// ---------- intents ----------
const INTENTS = [
  ['cancel',     /\b(cancel|batal|batalkan|tak jadi|x jadi|nak batal)\b/],
  ['reschedule', /\b(reschedule|re-schedule|tukar|ubah|anjak|move|change (my|the) (appointment|booking|time|date)|postpone|tangguh)\b/],
  ['hours',      /\b(hours?|opening|open|close|closing|waktu|buka|tutup|operating)\b/],
  ['location',   /\b(location|address|where|alamat|lokasi|mana|waze|map|direction)\b/],
  ['price',      /\b(price|harga|berapa|how much|cost|fee|bayar|charge)\b/],
  ['staff',      /\b(staff|human|person|operator|doctor|doktor|cakap dengan|talk to|speak to|call me|telefon|nurse|receptionist|manusia|orang)\b/],
  ['book',       /\b(book|booking|appointment|appt|tempah|tempahan|temujanji|temu janji|slot|reserve|jumpa doktor|nak datang|schedule)\b/],
  ['greeting',   /^(hi|hello|hey|helo|hai|assalamualaikum|salam|selamat (pagi|petang|malam|tengahari)|good (morning|afternoon|evening)|yo|start|menu|mula|help|tolong)\b/],
  ['thanks',     /\b(thanks?|thank you|terima kasih|tq|ty|tks)\b/],
];

// Chinese has no word boundaries, so these are plain substring patterns, checked first when the text has CJK.
const INTENTS_ZH = [
  ['cancel',     /取消|不来了|不去了|不要了|作废/],
  ['reschedule', /改时间|改期|改约|换时间|换个时间|更改|推迟|延后|改一下|换一天|改天/],
  ['staff',      /真人|人工|客服|找人|前台|护士|打电话|联系你们|跟人说|跟人讲|找医生|医生在吗/],
  ['hours',      /营业时间|几点开|几点关|开门|关门|什么时候开|开到几点|营业/],
  ['location',   /地址|在哪|怎么去|怎么走|位置|地点|地图|导航/],
  ['price',      /价格|多少钱|收费|费用|价钱|几钱|贵不贵|要多少/],
  ['book',       /预约|预定|预订|订位|挂号|排期|约个|约时间|想来|要来|看牙|看医生|订一个|约一下|做一个/],
  ['greeting',   /^(你好|您好|嗨|哈喽|哈啰|早上好|早安|下午好|晚上好|晚安|开始|菜单|在吗|hi|hello)/],
  ['thanks',     /谢谢|多谢|感谢|谢了|辛苦了/],
];

function detectIntent(text) {
  const t = norm(text);
  if (hasCJK(t)) { for (const [name, re] of INTENTS_ZH) if (re.test(t)) return name; }
  for (const [name, re] of INTENTS) if (re.test(t)) return name;
  return null;
}

// ---------- yes / no ----------
function isYes(text) {
  const t = norm(text);
  if (hasCJK(t)) return /^(是|是的|好|好的|好啊|可以|可以的|确认|确定|对|对的|没错|行|嗯|要|要的|ok|好的呀|没问题|正确)(。|！|!|\s|$)/.test(t) || /确认|没错|正确|没问题/.test(t);
  return /^(y|ya|yes|yup|yeah|ok|okay|okey|sure|confirm|sah|sahkan|betul|boleh|baik|setuju|1|✅|👍)\b/.test(t) || /\b(confirm|sahkan|ya betul|yes please|ok confirm)\b/.test(t);
}
function isNo(text) {
  const t = norm(text);
  if (hasCJK(t)) return /^(不|不是|不要|不对|不行|错|错了|否|取消|不用|不需要|不可以)(。|！|!|\s|$)/.test(t) || /^(不|不对|错了)/.test(t);
  return /^(n|no|nope|tak|tidak|x|bukan|salah|cancel|batal|jangan|2|❌)\b/.test(t);
}

function pickNumber(text, max) {
  // "2", "no 2", "第2个", "2号", "选2", "二"
  const t = cnToDigits(norm(text)).replace(/^(第|选|选择|要|我要|option|pilihan|nombor|number|no\.?)\s*/, '').replace(/\s*(个|号|項|项|吧|。|\.|\))\s*$/, '');
  const m = t.match(/^\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

// ---------- dates ----------
const DOW_MS = { ahad: 0, isnin: 1, selasa: 2, rabu: 3, khamis: 4, jumaat: 5, sabtu: 6 };
const DOW_EN = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const MONTHS = { jan: 1, january: 1, januari: 1, feb: 2, february: 2, februari: 2, mar: 3, march: 3, mac: 3, apr: 4, april: 4, may: 5, mei: 5, jun: 6, june: 6, jul: 7, july: 7, julai: 7, aug: 8, august: 8, ogos: 8, ogo: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12, dis: 12, disember: 12 };

// Returns 'YYYY-MM-DD' or null. todayStr is the clinic-local date.
const DOW_ZH = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
function parseDateZh(text, todayStr) {
  const t = text;
  if (/大后天|大後天/.test(t)) return addDays(todayStr, 3);
  if (/后天|後天/.test(t)) return addDays(todayStr, 2);
  if (/明天|明日|听日/.test(t)) return addDays(todayStr, 1);
  if (/今天|今日|现在|現在/.test(t)) return todayStr;
  // 10月30日 / 10月30号 / 十月三十号
  let m = cnToDigits(t).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(日|号|號)?/);
  if (m) {
    const y = Number(todayStr.slice(0, 4));
    const ds = `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
    if (validDate(ds)) return rollForward(ds, todayStr, true);
  }
  // 30号 (this month, or next if passed)
  m = cnToDigits(t).match(/(?:^|[^\d月])(\d{1,2})\s*(号|號|日)(?!\s*[月])/);
  if (m && !/星期|周|礼拜|禮拜/.test(t)) {
    const [y, mo] = todayStr.split('-').map(Number);
    let ds = `${y}-${pad(mo)}-${pad(Number(m[1]))}`;
    if (validDate(ds) && ds >= todayStr) return ds;
    const nm = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
    ds = `${nm}-${pad(Number(m[1]))}`;
    if (validDate(ds)) return ds;
  }
  // 星期一 / 周一 / 礼拜一 / 週一, optional 下 (next week) / 这 (this)
  m = t.match(/(下|这|這|本)?\s*(星期|周|週|礼拜|禮拜)\s*([一二三四五六日天])/);
  if (m) {
    const dow = DOW_ZH[m[3]];
    const todayDow = dowOf(todayStr);
    let delta = (dow - todayDow + 7) % 7;               // 星期三 / 这周三 = the coming Wednesday
    if (m[1] === '下') {                                 // 下周三 = Wednesday of NEXT calendar week (Mon–Sun)
      const toNextMonday = ((8 - todayDow) % 7) || 7;
      delta = toNextMonday + ((dow === 0 ? 7 : dow) - 1);
    }
    return addDays(todayStr, delta);
  }
  return null;
}

function parseDate(text, todayStr) {
  if (hasCJK(text)) { const z = parseDateZh(text, todayStr); if (z) return z; }
  const t = norm(text);
  if (/\b(today|hari ini|harini|hari ni|sekarang|now)\b/.test(t)) return todayStr;
  if (/\b(day after tomorrow|lusa)\b/.test(t)) return addDays(todayStr, 2);
  if (/\b(tomorrow|tmr|tmrw|tomoro|esok|bsk|esk)\b/.test(t)) return addDays(todayStr, 1);

  // numeric: 30/10, 30-10, 30/10/2026, 30.10 (but not "3.30pm")
  for (const m of t.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b(?!\s*(?:am|pm|pagi|petang|malam))/g)) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : Number(todayStr.slice(0, 4));
    if (y < 100) y += 2000;
    const ds = `${y}-${pad(mo)}-${pad(d)}`;
    if (validDate(ds)) return rollForward(ds, todayStr, !m[3]);
  }
  // "30 oct", "30 oktober", "oct 30", "30hb okt"
  const m = t.match(/\b(\d{1,2})\s*(?:hb|th|st|nd|rd)?\s+([a-z]{3,9})\b/) || t.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const a = m[1], b = m[2];
    const d = /^\d/.test(a) ? Number(a) : Number(b);
    const mon = MONTHS[/^\d/.test(a) ? b : a];
    if (mon) {
      const y = Number(todayStr.slice(0, 4));
      const ds = `${y}-${pad(mon)}-${pad(d)}`;
      if (validDate(ds)) return rollForward(ds, todayStr, true);
    }
  }
  // weekday, optional "next"/"depan"/"this"
  const words = t.split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const dow = DOW_MS[w] ?? DOW_EN[w];
    if (dow === undefined) continue;
    // "next monday" / "isnin depan" = the coming Monday (never today); "monday next week" / "isnin minggu depan" = a week later
    const isNext = words[i - 1] === 'next' || words[i + 1] === 'depan' || words[i + 1] === 'hadapan';
    const todayDow = dowOf(todayStr);
    let delta = (dow - todayDow + 7) % 7;
    if (isNext && delta === 0) delta = 7;
    if (/\b(minggu depan|next week|minggu hadapan)\b/.test(t)) delta += 7;
    return addDays(todayStr, delta);
  }
  return null;
}
function validDate(ds) { const [y, m, d] = ds.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
function rollForward(ds, todayStr, noYearGiven) {
  if (noYearGiven && ds < todayStr) { const [y, m, d] = ds.split('-'); return `${Number(y) + 1}-${m}-${d}`; }
  return ds;
}

// ---------- times ----------
// Returns { time: 'HH:MM' } or { period: 'morning'|'afternoon'|'evening' } or null.
function parseTimeZh(text) {
  const t = cnToDigits(text);
  const period = /早上|早晨|上午|早点|早一点/.test(t) ? 'morning'
    : /中午|午饭|午餐/.test(t) ? 'midday'
    : /下午|午后/.test(t) ? 'xiawu'
    : /傍晚|晚上|晚间|夜晚|夜里/.test(t) ? 'evening' : null;
  // 3点 / 3点半 / 3点30分 / 3:30 / 15点 / 下午3点 / 3pm
  const m = t.match(/(\d{1,2})\s*(?:点|點|时|時|:|：)\s*(半|\d{1,2})?\s*(分)?\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]); const mm = m[2] === '半' ? 30 : Number(m[2] || 0);
    if (h <= 24 && mm <= 59) {
      const suf = (m[4] || '').toLowerCase();
      if ((suf === 'pm' || period === 'xiawu' || period === 'afternoon' || period === 'evening' || period === 'midday') && h < 12) h += 12;
      else if (suf === 'am' && h === 12) h = 0;
      else if (!suf && !period && h <= 7) h += 12; // "3点" at a clinic → 3pm
      return { time: `${pad(h)}:${pad(mm)}` };
    }
  }
  const m2 = t.match(/(\d{1,2})\s*(am|pm)\b/i);
  if (m2) { let h = Number(m2[1]); if (m2[2].toLowerCase() === 'pm' && h < 12) h += 12; if (m2[2].toLowerCase() === 'am' && h === 12) h = 0; return { time: `${pad(h)}:00` }; }
  return period ? { period } : null;
}

function parseTime(text) {
  if (hasCJK(text)) { const z = parseTimeZh(text); if (z) return z; }
  const t = norm(text);
  const period = /\b(morning|pagi)\b/.test(t) ? 'morning'
    : /\b(tengah ?hari|tgh hari|noon|lunch|lepas lunch|midday)\b/.test(t) ? 'midday'
    : /\b(petang)\b/.test(t) ? 'petang'
    : /\b(afternoon)\b/.test(t) ? 'afternoon'
    : /\b(evening|night|malam)\b/.test(t) ? 'evening' : null;

  // 3pm, 3 pm, 3.30pm, 3:30 pm, 15:00, pukul 3, jam 3.30, 3 petang — skip numbers that are part of a date (28/10)
  for (const m of t.matchAll(/(pukul|jam|at|pkl)?\s*\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|pagi|petang|malam|tengahari|tgh hari)?\b/g)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 1);
    const before = t.slice(Math.max(0, m.index - 1), m.index);
    if (/[\/\-]/.test(after) || /[\/\-]/.test(before)) continue; // part of a date
    const hasMinutes = m[3] !== undefined, suf = m[4] || '', prefixed = !!m[1];
    if (!hasMinutes && !suf && !prefixed) continue;
    let h = Number(m[2]); const mm = Number(m[3] || 0);
    if (h > 24 || mm > 59) continue;
    if (/pm|petang|malam|tgh|tengah/.test(suf) && h < 12) h += 12;
    else if (/am|pagi/.test(suf) && h === 12) h = 0;
    else if (!suf && h <= 7) h += 12; // "pukul 3" at a clinic almost always means 3pm
    else if (!suf && (period === 'afternoon' || period === 'petang' || period === 'evening' || period === 'midday') && h < 12) h += 12;
    return { time: `${pad(h)}:${pad(mm)}` };
  }
  return period ? { period } : null;
}

function periodFilter(period) {
  return s => {
    const h = Number(s.slice(0, 2));
    if (period === 'morning') return h < 12;
    if (period === 'midday') return h >= 12 && h < 14;
    if (period === 'afternoon') return h >= 12 && h < 17;
    if (period === 'petang') return h >= 14 && h < 19;
    if (period === 'xiawu') return h >= 13 && h < 18;   // 下午: 1pm–6pm (12 is 中午)
    if (period === 'evening') return h >= 17;
    return true;
  };
}

// ---------- services ----------
const SERVICE_SYNONYMS = {
  checkup: ['checkup', 'check up', 'check-up', 'scaling', 'cleaning', 'clean', 'polish', 'cuci gigi', 'pemeriksaan', 'periksa', 'tartar', 'karang gigi', 'routine', 'general'],
  filling: ['filling', 'fill', 'tampal', 'tampalan', 'lubang', 'cavity', 'hole', 'rosak'],
  extraction: ['extraction', 'extract', 'remove', 'pull', 'cabut', 'buang gigi', 'wisdom', 'geraham bongsu'],
  whitening: ['whitening', 'whiten', 'putih', 'pemutihan', 'bleach'],
  braces: ['braces', 'brace', 'pendakap', 'ortho', 'orthodontic', 'aligner', 'invisalign', 'retainer'],
};
const SERVICE_SYNONYMS_ZH = {
  checkup: ['洗牙', '洁牙', '检查', '檢查', '牙石', '牙结石', '牙垢', '清洁', '定期检查', '例行'],
  filling: ['补牙', '補牙', '蛀牙', '补一下', '填牙', '牙洞', '烂牙', '爛牙'],
  extraction: ['拔牙', '拔掉', '拔智齿', '智齿', '智慧牙', '拔'],
  whitening: ['美白', '漂白', '牙齿美白', '牙齒美白', '变白', '洗白'],
  braces: ['牙套', '矫正', '矯正', '箍牙', '隐形牙套', '隱形', '矫牙', '正畸', '牙齿矫正'],
};
function matchService(text, services) {
  const t = norm(text);
  const n = pickNumber(text, services.length);
  if (n) return services[n - 1];
  if (hasCJK(t)) {
    for (const s of services) {
      const syns = SERVICE_SYNONYMS_ZH[s.id] || [];
      if ((s.zh && t.includes(norm(s.zh))) || syns.some(x => t.includes(x))) return s;
    }
    if (/牙疼|牙痛|痛|疼|酸|敏感|出血|流血|肿|腫/.test(t)) return services.find(s => s.id === 'checkup') || null;
  }
  for (const s of services) {
    const syns = SERVICE_SYNONYMS[s.id] || [];
    const names = [s.ms, s.en].map(norm);
    if (names.some(x => t.includes(x)) || syns.some(x => t.includes(x))) return s;
  }
  // generic "pain" -> checkup
  if (/\b(sakit|pain|hurt|ache|sensitif|sensitive|bleed|berdarah|bengkak|swollen)\b/.test(t)) return services.find(s => s.id === 'checkup') || null;
  return null;
}

// ---------- names ----------
function extractName(text) {
  const raw = (text || '').trim();
  if (hasCJK(raw)) {
    // 我叫陈美玲 / 我是王小明 / 名字是林志强 / 陈美玲 — Chinese names are 2–4 characters; also accept Latin names mixed in
    const m = raw.match(/(?:我叫|我是|名字是|名字|姓名|叫我|叫)\s*[:：]?\s*([\u4e00-\u9fff]{2,5})/) || raw.match(/^([\u4e00-\u9fff]{2,4})(?:[。！!，,]|$)/);
    if (m && !/^(你好|谢谢|可以|好的|不是|取消|预约|洗牙|补牙|拔牙|美白|牙套|医生)$/.test(m[1])) return m[1];
    const latin = raw.match(/([A-Za-z][A-Za-z@' .\-]{1,39})/);
    if (latin) return latin[1].trim().split(' ').map(w => w.length > 1 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    return null;
  }
  const m = raw.match(/(?:nama saya|name is|saya|i am|i'm|im|this is|ini)\s+([A-Za-z@' .\-]{2,40})$/i);
  const cand = (m ? m[1] : raw).replace(/[^A-Za-z@' .\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cand.length < 2 || cand.length > 40) return null;
  if (/^(ok|ya|yes|no|tak|hi|hello|book|tempah)$/i.test(cand)) return null;
  return cand.split(' ').map(w => w.length > 1 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

module.exports = { norm, hasCJK, cnToDigits, detectLanguage, detectIntent, isYes, isNo, pickNumber, parseDate, parseTime, periodFilter, matchService, extractName };
