// WhatsApp message templates the bot sends outside the 24h customer-service window (the day-before and
// same-day reminders). One template name per reminder, one version per language. Body parameters match
// buildReminder() in engine/conversation.js: 24h = name, clinic, date, time, service; 2h = name, clinic,
// hours, time, address. Quick-reply payloads (rem_yes / rem_resched / rem_cancel) are set when sending.
//
// Meta language codes: Malay = ms, English = en, Simplified Chinese = zh_CN.

const EX24 = {
  ms: ['Sarah Lim', 'Klinik Sinar', 'Esok (Khamis, 29 Okt)', '2 petang', 'Pemeriksaan & Scaling'],
  en: ['Sarah Lim', 'Klinik Sinar', 'Tomorrow (Thu, 29 Oct)', '2pm', 'Check-up & Scaling'],
  zh_CN: ['陈美玲', 'Sinar 牙科诊所', '明天（10月29日 周四）', '下午2点', '检查与洗牙'],
};
const EX2 = {
  ms: ['Sarah Lim', 'Klinik Sinar', '2', '2 petang', 'No. 12, Jalan Setia 3, 40170 Shah Alam'],
  en: ['Sarah Lim', 'Klinik Sinar', '2', '2pm', 'No. 12, Jalan Setia 3, 40170 Shah Alam'],
  zh_CN: ['陈美玲', 'Sinar 牙科诊所', '2', '下午2点', 'No. 12, Jalan Setia 3, 40170 Shah Alam'],
};

const BODY24 = {
  ms: 'Hai {{1}}, ini peringatan temujanji anda di {{2}} pada {{3}} jam {{4}} untuk {{5}}. Sila tekan butang di bawah untuk sahkan kehadiran, tukar masa atau batalkan. Terima kasih!',
  en: 'Hi {{1}}, this is a reminder of your appointment at {{2}} on {{3}} at {{4}} for {{5}}. Please tap a button below to confirm, reschedule or cancel. Thank you!',
  zh_CN: '您好 {{1}}，这是您在{{2}}的预约提醒：日期 {{3}}，时间 {{4}}，项目：{{5}}。请点击下方按钮确认、更改时间或取消。谢谢！',
};
const BTN24 = {
  ms: ['Ya, saya datang', 'Tukar masa', 'Batal'],
  en: ["Yes, I'll be there", 'Reschedule', 'Cancel'],
  zh_CN: ['可以，我会到', '更改时间', '取消'],
};
const BODY2 = {
  ms: 'Hai {{1}}, peringatan ringkas: temujanji anda di {{2}} adalah dalam {{3}} jam lagi, pada {{4}}. Alamat kami: {{5}}. Sila tiba beberapa minit lebih awal. Jumpa nanti!',
  en: 'Hi {{1}}, a quick reminder that your appointment at {{2}} is in {{3}} hours, at {{4}}. Our address: {{5}}. Please arrive a few minutes early. See you soon!',
  zh_CN: '您好 {{1}}，温馨提醒：您在{{2}}的预约还有{{3}}小时，时间 {{4}}。我们的地址：{{5}}。请提早几分钟到达。到时见！',
};

function defs(names = { reminder_24h: 'appt_reminder_24h', reminder_2h: 'appt_reminder_2h' }) {
  const out = [];
  for (const lang of ['ms', 'en', 'zh_CN']) {
    out.push({
      name: names.reminder_24h, language: lang, category: 'UTILITY',
      components: [
        { type: 'BODY', text: BODY24[lang], example: { body_text: [EX24[lang]] } },
        { type: 'BUTTONS', buttons: BTN24[lang].map(text => ({ type: 'QUICK_REPLY', text })) },
      ],
    });
    out.push({
      name: names.reminder_2h, language: lang, category: 'UTILITY',
      components: [{ type: 'BODY', text: BODY2[lang], example: { body_text: [EX2[lang]] } }],
    });
  }
  return out;
}

module.exports = { defs, BODY24, BODY2, BTN24 };
