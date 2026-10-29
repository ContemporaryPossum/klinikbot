// All bot copy in Malay (ms) and English (en). Keep it short — it's WhatsApp.
const { dowOf } = require('./scheduling');

const DOW = {
  ms: ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
};
const MON = {
  ms: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogos', 'Sep', 'Okt', 'Nov', 'Dis'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

function fmtDate(dateStr, lang, todayStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = DOW[lang][dowOf(dateStr)];
  const base = lang === 'zh' ? `${m}月${d}日 ${dow}` : `${dow}, ${d} ${MON[lang][m - 1]}`;
  if (todayStr) {
    if (dateStr === todayStr) return lang === 'ms' ? `Hari ini (${base})` : lang === 'zh' ? `今天（${base}）` : `Today (${base})`;
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
    if (diff === 1) return lang === 'ms' ? `Esok (${base})` : lang === 'zh' ? `明天（${base}）` : `Tomorrow (${base})`;
  }
  return base;
}
function fmtTime(hhmm, lang) {
  const [h, m] = hhmm.split(':').map(Number);
  if (lang === 'zh') {
    const period = h < 12 ? '上午' : h === 12 ? '中午' : h < 18 ? '下午' : '晚上';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${period}${h12}点${m === 30 ? '半' : m ? String(m).padStart(2, '0') + '分' : ''}`;
  }
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}.${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}
function svcName(s, lang) { return s[lang] || s.en; }
function price(s, lang) {
  if (!s.price_from) return lang === 'ms' ? 'percuma' : lang === 'zh' ? '免费' : 'free';
  return lang === 'ms' ? `dari RM${s.price_from}` : lang === 'zh' ? `RM${s.price_from}起` : `from RM${s.price_from}`;
}

const M = {
  ms: {
    greeting: (c, name) => `${name ? `Hai ${name}! ` : 'Hai! '}Selamat datang ke *${c.name.ms}* 🦷\n\nSaya pembantu tempahan klinik. Apa yang boleh saya bantu?`,
    menu: () => `Pilih satu:\n\n*1* – Tempah temujanji\n*2* – Tukar / batal temujanji\n*3* – Waktu operasi & lokasi\n*4* – Cakap dengan staf\n\n_Taip nombor atau terus beritahu, contoh: "nak scaling esok petang"_`,
    menuButtons: () => [{ id: 'book', title: 'Tempah' }, { id: 'manage', title: 'Tukar / Batal' }, { id: 'info', title: 'Waktu & Lokasi' }],
    askService: (c) => `Rawatan apa yang anda perlukan?\n\n${c.services.map((s, i) => `*${i + 1}* – ${svcName(s, 'ms')} (${price(s, 'ms')})`).join('\n')}`,
    askDate: () => `Bila anda nak datang? Boleh taip contoh: *esok*, *Sabtu*, atau *30/10*.`,
    askDateWithOptions: (dates, today) => `Bila anda nak datang?\n\n${dates.map((d, i) => `*${i + 1}* – ${fmtDate(d, 'ms', today)}`).join('\n')}\n\n_Atau taip tarikh lain, contoh: "Sabtu depan" atau "5/11"_`,
    closedOn: (d, today, alts) => `Maaf, klinik tutup pada ${fmtDate(d, 'ms', today)}. Hari terdekat yang ada:\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'ms', today)}`).join('\n')}`,
    noSlots: (d, today, alts) => `Maaf, ${fmtDate(d, 'ms', today)} sudah penuh. Hari terdekat yang ada:\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'ms', today)}`).join('\n')}`,
    tooFar: (max) => `Maaf, tempahan hanya boleh dibuat sehingga ${max} hari ke hadapan. Sila pilih tarikh lain.`,
    pastDate: () => `Tarikh itu sudah berlalu. Sila pilih tarikh lain, contoh: *esok* atau *Sabtu*.`,
    askTime: (d, today, slots) => `Slot kosong pada ${fmtDate(d, 'ms', today)}:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'ms')}`).join('\n')}\n\n_Taip nombor, atau contoh "petang" / "3pm"_`,
    timeTaken: (t, slots) => `Maaf, ${fmtTime(t, 'ms')} sudah diambil. Yang terdekat:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'ms')}`).join('\n')}`,
    noSlotsPeriod: (slots) => `Tiada slot pada waktu itu. Slot lain yang ada:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'ms')}`).join('\n')}`,
    askName: () => `Boleh saya tahu nama penuh anda?`,
    confirm: (c, b, s, today) => `Sila semak tempahan anda:\n\n👤 *${b.name}*\n🦷 ${svcName(s, 'ms')}\n📅 ${fmtDate(b.date, 'ms', today)}\n🕒 ${fmtTime(b.time, 'ms')}\n📍 ${c.short_name}, ${c.address.split(',').slice(-2).join(',').trim()}\n\nBetul? Balas *YA* untuk sahkan atau *TAK* untuk ubah.`,
    confirmButtons: () => [{ id: 'yes', title: 'Ya, sahkan ✅' }, { id: 'no', title: 'Ubah' }],
    booked: (c, b, s, today) => `✅ *Tempahan disahkan!*\n\n📅 ${fmtDate(b.date, 'ms', today)} jam ${fmtTime(b.time, 'ms')}\n🦷 ${svcName(s, 'ms')}\n📍 ${c.address}\n🗺️ Waze: ${c.waze_url}\n\nNo. rujukan: *#${b.id}*\n\nSaya akan hantar peringatan sehari sebelum. Jika perlu tukar, balas "tukar" bila-bila masa.`,
    deposit: (c) => `💳 Untuk kunci slot anda, sila buat deposit *RM${c.deposit.amount}* melalui DuitNow:\n${c.deposit.duitnow_url || '(QR DuitNow klinik)'}\n\n${c.deposit.note.ms} Hantar screenshot resit di sini selepas bayar ya.`,
    notConfirmed: () => `Baik, tempahan belum disahkan. Apa yang anda nak ubah?\n\n*1* – Rawatan\n*2* – Tarikh\n*3* – Masa\n*4* – Nama\n*5* – Batal sahaja`,
    noUpcoming: () => `Saya tak jumpa temujanji akan datang untuk nombor ini. Nak buat tempahan baru? Balas *1*.`,
    yourBookings: (bs, services, today) => `Temujanji anda:\n\n${bs.map((b, i) => `*${i + 1}* – ${fmtDate(b.date, 'ms', today)} ${fmtTime(b.time, 'ms')} · ${svcName(services.find(s => s.id === b.service_id) || {}, 'ms')} (#${b.id})`).join('\n')}\n\nYang mana?`,
    manageWhat: (b, s, today) => `Temujanji #${b.id}: ${fmtDate(b.date, 'ms', today)} ${fmtTime(b.time, 'ms')} · ${svcName(s, 'ms')}\n\n*1* – Tukar tarikh/masa\n*2* – Batal temujanji\n*3* – Kekal, tiada perubahan`,
    cancelConfirm: (b, today) => `Batal temujanji pada ${fmtDate(b.date, 'ms', today)} ${fmtTime(b.time, 'ms')}? Balas *YA* untuk batal.`,
    cancelled: (b) => `Temujanji #${b.id} telah dibatalkan. Jika nak tempah semula, balas *1* bila-bila masa. Terima kasih! 🙏`,
    rescheduled: (c, b, s, today) => `✅ *Temujanji ditukar!*\n\n📅 ${fmtDate(b.date, 'ms', today)} jam ${fmtTime(b.time, 'ms')}\n🦷 ${svcName(s, 'ms')}\n📍 ${c.short_name}\n\nNo. rujukan: *#${b.id}*. Jumpa nanti!`,
    info: (c) => `📍 *${c.name.ms}*\n${c.address}\n🗺️ Waze: ${c.waze_url}\n📞 ${c.phone}\n\n🕒 *Waktu operasi*\n${hoursText(c, 'ms')}\n\nNak tempah temujanji? Balas *1*.`,
    priceList: (c) => `💰 *Anggaran harga*\n${c.services.map(s => `• ${svcName(s, 'ms')} – ${price(s, 'ms')}`).join('\n')}\n\n_Harga sebenar bergantung pada pemeriksaan doktor._\n\nNak tempah? Balas *1*.`,
    handoff: (c) => `Baik, saya maklumkan staf klinik sekarang. Mereka akan balas di sini sebentar lagi (waktu operasi). Terima kasih kerana menunggu 🙏`,
    handoffActive: () => `Staf kami akan balas sebentar lagi. Jika nak kembali ke menu automatik, taip *menu*.`,
    thanks: () => `Sama-sama! Jumpa nanti 😊`,
    fallback: () => `Maaf, saya tak faham. Taip *menu* untuk pilihan, atau terus beritahu, contoh: "nak scaling esok petang".`,
    reminder: (c, b, s, hrs, today) => hrs >= 12
      ? `⏰ *Peringatan temujanji esok*\n\nHai ${b.name || ''}, jumpa anda esok di ${c.short_name}:\n📅 ${fmtDate(b.date, 'ms', today)} jam ${fmtTime(b.time, 'ms')}\n🦷 ${svcName(s, 'ms')}\n\nBoleh datang?\n*1* – Ya, saya datang\n*2* – Tukar masa\n*3* – Batal`
      : `⏰ Hai ${b.name || ''}, temujanji anda di ${c.short_name} adalah dalam ${hrs} jam lagi (${fmtTime(b.time, 'ms')}).\n📍 ${c.address}\n🗺️ ${c.waze_url}\n\nJumpa nanti! Balas *2* jika perlu tukar masa.`,
    reminderButtons: () => [{ id: 'rem_yes', title: 'Ya, saya datang' }, { id: 'rem_resched', title: 'Tukar masa' }, { id: 'rem_cancel', title: 'Batal' }],
    reminderConfirmed: () => `Terima kasih! Jumpa esok 😊`,
    langSwitched: () => `Baik, saya balas dalam Bahasa Melayu.`,
  },
  en: {
    greeting: (c, name) => `${name ? `Hi ${name}! ` : 'Hi! '}Welcome to *${c.name.en}* 🦷\n\nI'm the clinic's booking assistant. How can I help?`,
    menu: () => `Choose one:\n\n*1* – Book an appointment\n*2* – Reschedule / cancel\n*3* – Opening hours & location\n*4* – Talk to staff\n\n_Type a number, or just tell me, e.g. "scaling tomorrow afternoon"_`,
    menuButtons: () => [{ id: 'book', title: 'Book' }, { id: 'manage', title: 'Reschedule/Cancel' }, { id: 'info', title: 'Hours & Location' }],
    askService: (c) => `What treatment do you need?\n\n${c.services.map((s, i) => `*${i + 1}* – ${svcName(s, 'en')} (${price(s, 'en')})`).join('\n')}`,
    askDate: () => `When would you like to come? You can type e.g. *tomorrow*, *Saturday*, or *30/10*.`,
    askDateWithOptions: (dates, today) => `When would you like to come?\n\n${dates.map((d, i) => `*${i + 1}* – ${fmtDate(d, 'en', today)}`).join('\n')}\n\n_Or type another date, e.g. "next Saturday" or "5/11"_`,
    closedOn: (d, today, alts) => `Sorry, we're closed on ${fmtDate(d, 'en', today)}. Nearest available days:\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'en', today)}`).join('\n')}`,
    noSlots: (d, today, alts) => `Sorry, ${fmtDate(d, 'en', today)} is fully booked. Nearest available days:\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'en', today)}`).join('\n')}`,
    tooFar: (max) => `Sorry, bookings can only be made up to ${max} days ahead. Please pick another date.`,
    pastDate: () => `That date has passed. Please pick another, e.g. *tomorrow* or *Saturday*.`,
    askTime: (d, today, slots) => `Available slots on ${fmtDate(d, 'en', today)}:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'en')}`).join('\n')}\n\n_Type a number, or e.g. "afternoon" / "3pm"_`,
    timeTaken: (t, slots) => `Sorry, ${fmtTime(t, 'en')} is taken. Nearest slots:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'en')}`).join('\n')}`,
    noSlotsPeriod: (slots) => `No slots at that time. Other available slots:\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'en')}`).join('\n')}`,
    askName: () => `May I have your full name?`,
    confirm: (c, b, s, today) => `Please check your booking:\n\n👤 *${b.name}*\n🦷 ${svcName(s, 'en')}\n📅 ${fmtDate(b.date, 'en', today)}\n🕒 ${fmtTime(b.time, 'en')}\n📍 ${c.short_name}, ${c.address.split(',').slice(-2).join(',').trim()}\n\nCorrect? Reply *YES* to confirm or *NO* to change.`,
    confirmButtons: () => [{ id: 'yes', title: 'Yes, confirm ✅' }, { id: 'no', title: 'Change' }],
    booked: (c, b, s, today) => `✅ *Booking confirmed!*\n\n📅 ${fmtDate(b.date, 'en', today)} at ${fmtTime(b.time, 'en')}\n🦷 ${svcName(s, 'en')}\n📍 ${c.address}\n🗺️ Waze: ${c.waze_url}\n\nReference: *#${b.id}*\n\nI'll send a reminder the day before. Need to change? Reply "reschedule" any time.`,
    deposit: (c) => `💳 To secure your slot, please pay a *RM${c.deposit.amount}* deposit via DuitNow:\n${c.deposit.duitnow_url || '(clinic DuitNow QR)'}\n\n${c.deposit.note.en} Send a screenshot of the receipt here once paid.`,
    notConfirmed: () => `No problem, nothing booked yet. What would you like to change?\n\n*1* – Treatment\n*2* – Date\n*3* – Time\n*4* – Name\n*5* – Just cancel`,
    noUpcoming: () => `I couldn't find any upcoming appointment for this number. Want to make a new booking? Reply *1*.`,
    yourBookings: (bs, services, today) => `Your appointments:\n\n${bs.map((b, i) => `*${i + 1}* – ${fmtDate(b.date, 'en', today)} ${fmtTime(b.time, 'en')} · ${svcName(services.find(s => s.id === b.service_id) || {}, 'en')} (#${b.id})`).join('\n')}\n\nWhich one?`,
    manageWhat: (b, s, today) => `Appointment #${b.id}: ${fmtDate(b.date, 'en', today)} ${fmtTime(b.time, 'en')} · ${svcName(s, 'en')}\n\n*1* – Change date/time\n*2* – Cancel appointment\n*3* – Keep it, no changes`,
    cancelConfirm: (b, today) => `Cancel your appointment on ${fmtDate(b.date, 'en', today)} ${fmtTime(b.time, 'en')}? Reply *YES* to cancel.`,
    cancelled: (b) => `Appointment #${b.id} has been cancelled. To book again, reply *1* any time. Thank you! 🙏`,
    rescheduled: (c, b, s, today) => `✅ *Appointment moved!*\n\n📅 ${fmtDate(b.date, 'en', today)} at ${fmtTime(b.time, 'en')}\n🦷 ${svcName(s, 'en')}\n📍 ${c.short_name}\n\nReference: *#${b.id}*. See you then!`,
    info: (c) => `📍 *${c.name.en}*\n${c.address}\n🗺️ Waze: ${c.waze_url}\n📞 ${c.phone}\n\n🕒 *Opening hours*\n${hoursText(c, 'en')}\n\nWant to book? Reply *1*.`,
    priceList: (c) => `💰 *Price guide*\n${c.services.map(s => `• ${svcName(s, 'en')} – ${price(s, 'en')}`).join('\n')}\n\n_Final price depends on the dentist's examination._\n\nWant to book? Reply *1*.`,
    handoff: (c) => `Sure, I've notified the clinic staff. They'll reply here shortly (during opening hours). Thanks for your patience 🙏`,
    handoffActive: () => `Our staff will reply shortly. To go back to the automated menu, type *menu*.`,
    thanks: () => `You're welcome! See you soon 😊`,
    fallback: () => `Sorry, I didn't catch that. Type *menu* for options, or just tell me, e.g. "scaling tomorrow afternoon".`,
    reminder: (c, b, s, hrs, today) => hrs >= 12
      ? `⏰ *Appointment reminder*\n\nHi ${b.name || ''}, see you tomorrow at ${c.short_name}:\n📅 ${fmtDate(b.date, 'en', today)} at ${fmtTime(b.time, 'en')}\n🦷 ${svcName(s, 'en')}\n\nCan you make it?\n*1* – Yes, I'll be there\n*2* – Reschedule\n*3* – Cancel`
      : `⏰ Hi ${b.name || ''}, your appointment at ${c.short_name} is in ${hrs} hours (${fmtTime(b.time, 'en')}).\n📍 ${c.address}\n🗺️ ${c.waze_url}\n\nSee you soon! Reply *2* if you need to reschedule.`,
    reminderButtons: () => [{ id: 'rem_yes', title: "Yes, I'll be there" }, { id: 'rem_resched', title: 'Reschedule' }, { id: 'rem_cancel', title: 'Cancel' }],
    reminderConfirmed: () => `Thank you! See you tomorrow 😊`,
    langSwitched: () => `Sure, I'll reply in English.`,
  },
  zh: {
    greeting: (c, name) => `${name ? `${name}，您好！` : '您好！'}欢迎来到 *${c.name.zh || c.name.en}* 🦷\n\n我是诊所的预约助手，请问有什么可以帮您？`,
    menu: () => `请选择：\n\n*1* – 预约看诊\n*2* – 更改 / 取消预约\n*3* – 营业时间与地址\n*4* – 联系前台\n\n_输入数字，或直接告诉我，例如：“明天下午洗牙”_`,
    menuButtons: () => [{ id: 'book', title: '预约' }, { id: 'manage', title: '更改 / 取消' }, { id: 'info', title: '时间与地址' }],
    askService: (c) => `请问需要哪项治疗？\n\n${c.services.map((s, i) => `*${i + 1}* – ${svcName(s, 'zh')}（${price(s, 'zh')}）`).join('\n')}`,
    askDate: () => `请问哪一天方便？可以输入：*明天*、*星期六*、或 *30/10*。`,
    askDateWithOptions: (dates, today) => `请问哪一天方便？\n\n${dates.map((d, i) => `*${i + 1}* – ${fmtDate(d, 'zh', today)}`).join('\n')}\n\n_或输入其他日期，例如“下周六”或“5/11”_`,
    closedOn: (d, today, alts) => `不好意思，${fmtDate(d, 'zh', today)}诊所休息。最近可预约的日期：\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'zh', today)}`).join('\n')}`,
    noSlots: (d, today, alts) => `不好意思，${fmtDate(d, 'zh', today)}已约满。最近可预约的日期：\n\n${alts.map((x, i) => `*${i + 1}* – ${fmtDate(x, 'zh', today)}`).join('\n')}`,
    tooFar: (max) => `不好意思，目前只接受 ${max} 天内的预约，请选择其他日期。`,
    pastDate: () => `这个日期已经过去了，请选择其他日期，例如 *明天* 或 *星期六*。`,
    askTime: (d, today, slots) => `${fmtDate(d, 'zh', today)}可预约的时间：\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'zh')}`).join('\n')}\n\n_输入数字，或例如“下午”/“3点”_`,
    timeTaken: (t, slots) => `不好意思，${fmtTime(t, 'zh')}已被预约。最接近的时间：\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'zh')}`).join('\n')}`,
    noSlotsPeriod: (slots) => `那个时段没有空位了。其他可预约的时间：\n\n${slots.map((s, i) => `*${i + 1}* – ${fmtTime(s, 'zh')}`).join('\n')}`,
    askName: () => `请问您的姓名？`,
    confirm: (c, b, s, today) => `请确认您的预约：\n\n👤 *${b.name}*\n🦷 ${svcName(s, 'zh')}\n📅 ${fmtDate(b.date, 'zh', today)}\n🕒 ${fmtTime(b.time, 'zh')}\n📍 ${c.short_name}，${c.address.split(',').slice(-2).join(',').trim()}\n\n正确吗？回复 *是* 确认，或 *不是* 修改。`,
    confirmButtons: () => [{ id: 'yes', title: '是，确认 ✅' }, { id: 'no', title: '修改' }],
    booked: (c, b, s, today) => `✅ *预约成功！*\n\n📅 ${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')}\n🦷 ${svcName(s, 'zh')}\n📍 ${c.address}\n🗺️ Waze：${c.waze_url}\n\n预约编号：*#${b.id}*\n\n我会在前一天发提醒给您。如需更改，随时回复“改时间”。`,
    deposit: (c) => `💳 为了保留您的时段，请通过 DuitNow 支付 *RM${c.deposit.amount}* 订金：\n${c.deposit.duitnow_url || '（诊所 DuitNow 二维码）'}\n\n${(c.deposit.note && c.deposit.note.zh) || '订金将从治疗费用中扣除。'} 付款后请把收据截图发到这里。`,
    notConfirmed: () => `好的，预约还没确认。请问要修改什么？\n\n*1* – 治疗项目\n*2* – 日期\n*3* – 时间\n*4* – 姓名\n*5* – 取消`,
    noUpcoming: () => `这个号码没有即将到来的预约。需要新预约吗？回复 *1*。`,
    yourBookings: (bs, services, today) => `您的预约：\n\n${bs.map((b, i) => `*${i + 1}* – ${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')} · ${svcName(services.find(s => s.id === b.service_id) || {}, 'zh')}（#${b.id}）`).join('\n')}\n\n请问是哪一个？`,
    manageWhat: (b, s, today) => `预约 #${b.id}：${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')} · ${svcName(s, 'zh')}\n\n*1* – 更改日期/时间\n*2* – 取消预约\n*3* – 保留，不更改`,
    cancelConfirm: (b, today) => `确定取消 ${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')} 的预约吗？回复 *是* 取消。`,
    cancelled: (b) => `预约 #${b.id} 已取消。如需重新预约，随时回复 *1*。谢谢！🙏`,
    rescheduled: (c, b, s, today) => `✅ *预约已更改！*\n\n📅 ${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')}\n🦷 ${svcName(s, 'zh')}\n📍 ${c.short_name}\n\n预约编号：*#${b.id}*。到时见！`,
    info: (c) => `📍 *${c.name.zh || c.name.en}*\n${c.address}\n🗺️ Waze：${c.waze_url}\n📞 ${c.phone}\n\n🕒 *营业时间*\n${hoursText(c, 'zh')}\n\n需要预约吗？回复 *1*。`,
    priceList: (c) => `💰 *价格参考*\n${c.services.map(s => `• ${svcName(s, 'zh')} – ${price(s, 'zh')}`).join('\n')}\n\n_实际费用视医生检查而定。_\n\n需要预约吗？回复 *1*。`,
    handoff: (c) => `好的，我已通知诊所前台，他们会在营业时间内尽快在这里回复您。谢谢耐心等待 🙏`,
    handoffActive: () => `前台会尽快回复您。如需返回自动菜单，请输入 *菜单*。`,
    thanks: () => `不客气！到时见 😊`,
    fallback: () => `不好意思，我没听懂。输入 *菜单* 查看选项，或直接告诉我，例如：“明天下午洗牙”。`,
    reminder: (c, b, s, hrs, today) => hrs >= 12
      ? `⏰ *预约提醒*\n\n${b.name || ''}您好，明天在 ${c.short_name} 见：\n📅 ${fmtDate(b.date, 'zh', today)} ${fmtTime(b.time, 'zh')}\n🦷 ${svcName(s, 'zh')}\n\n请问能准时到吗？\n*1* – 可以，我会到\n*2* – 更改时间\n*3* – 取消`
      : `⏰ ${b.name || ''}您好，您在 ${c.short_name} 的预约还有 ${hrs} 小时（${fmtTime(b.time, 'zh')}）。\n📍 ${c.address}\n🗺️ ${c.waze_url}\n\n到时见！如需更改时间，请回复 *2*。`,
    reminderButtons: () => [{ id: 'rem_yes', title: '可以，我会到' }, { id: 'rem_resched', title: '更改时间' }, { id: 'rem_cancel', title: '取消' }],
    reminderConfirmed: () => `谢谢！明天见 😊`,
    langSwitched: () => `好的，我用中文回复您。`,
  },
};

function hoursText(c, lang) {
  const names = lang === 'ms'
    ? { mon: 'Isnin', tue: 'Selasa', wed: 'Rabu', thu: 'Khamis', fri: 'Jumaat', sat: 'Sabtu', sun: 'Ahad' }
    : lang === 'zh' ? { mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六', sun: '周日' }
    : { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const closed = lang === 'ms' ? 'Tutup' : lang === 'zh' ? '休息' : 'Closed';
  // group consecutive identical days
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const lines = []; let start = 0;
  for (let i = 1; i <= order.length; i++) {
    const same = i < order.length && JSON.stringify(c.hours[order[i]]) === JSON.stringify(c.hours[order[start]]);
    if (!same) {
      const h = c.hours[order[start]];
      const label = start === i - 1 ? names[order[start]] : lang === 'zh' ? `${names[order[start]]}至${names[order[i - 1]]}` : `${names[order[start]]}–${names[order[i - 1]]}`;
      lines.push(`${label}${lang === 'zh' ? '：' : ': '}${h ? `${fmtTime(h[0], lang)} – ${fmtTime(h[1], lang)}` : closed}`);
      start = i;
    }
  }
  return lines.join('\n');
}

module.exports = { M, fmtDate, fmtTime, svcName };
