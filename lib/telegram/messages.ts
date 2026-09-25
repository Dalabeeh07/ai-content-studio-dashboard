// Bilingual (Arabic default / English) reply text for the Telegram bot.
//
// Parse mode is HTML. EVERY user-controlled value (URLs, usernames, campaign
// names) passes through esc() before it is interpolated - never build a
// reply by concatenating raw input. Static markup here is limited to
// <b>/<code>, which Telegram supports.

import { BOT_USERNAME, LINKS_PER_WINDOW, LINKS_WINDOW_SECONDS, MAX_URLS_PER_MESSAGE } from "./config";
import type { Lang } from "./types";
import type { Platform } from "./url";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline-keyboard button labels are plain text (Telegram does not parse HTML
// in them) - only length-bound and stripped of control characters.
export function plainLabel(s: string, max = 48): string {
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const LRI = "⁦"; // left-to-right isolate
const PDI = "⁩"; // pop directional isolate

// URL as it appears in a reply: scheme dropped, truncated, escaped, and
// wrapped in a bidi isolate so it never scrambles inside an Arabic sentence.
export function shortUrl(url: string, max = 60): string {
  const bare = url.replace(/^https?:\/\//i, "");
  const t = bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
  return `${LRI}${esc(t)}${PDI}`;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
};

export function detectLang(languageCode: string | undefined): Lang {
  // Default Arabic (the audience); English only when Telegram says English.
  return typeof languageCode === "string" && /^en(\b|[-_])/i.test(languageCode) ? "en" : "ar";
}

const mins = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

type Dict = {
  welcomeNew: () => string;
  welcomeBack: () => string;
  help: () => string;
  notLinked: () => string;
  linkUsage: () => string;
  linkOk: () => string;
  linkInvalid: () => string;
  linkAlready: () => string;
  linkTooMany: (retrySeconds: number) => string;
  linkBusy: () => string;
  noLinksFound: () => string;
  accepted: (platform: Platform, url: string) => string;
  duplicate: (url: string) => string;
  duplicateOther: (url: string) => string;
  unsupported: (url: string) => string;
  invalid: (url: string) => string;
  rateLimited: (count: number, retrySeconds: number) => string;
  itemError: (url: string) => string;
  ignored: (count: number) => string;
  repeated: (count: number) => string;
  todayTotal: (n: number) => string;
  campaignAuto: (name: string) => string;
  campaignAsk: () => string;
  campaignChosen: (name: string) => string;
  choiceExpired: () => string;
  myLinksHeader: () => string;
  myLinksEmpty: () => string;
  myLinkLine: (platform: Platform | string, url: string, status: string, whop: boolean) => string;
  status: (s: string) => string;
  count: (n: number) => string;
  unlinkAsk: () => string;
  unlinkYes: () => string;
  unlinkNo: () => string;
  unlinkDone: () => string;
  unlinkCancelled: () => string;
  unlinkNotLinked: () => string;
  langSet: () => string;
  tempError: () => string;
};

const ar: Dict = {
  welcomeNew: () =>
    `أهلاً بك في بوت استلام الروابط 👋\n\n` +
    `أرسل لي روابط فيديوهاتك بعد نشرها (تيك توك، إنستغرام، يوتيوب شورتس، إكس) وسأسجّلها لك.\n\n` +
    `للبدء اربط حسابك بالكود الذي أعطاك إياه المشرف:\n<code>/link ABCD-EFGH</code>\n\n` +
    `اكتب /help لعرض كل الأوامر.`,
  welcomeBack: () => `أهلاً بعودتك ✅ حسابك مربوط. أرسل لي رابط الفيديو بعد نشره وسأسجّله.\n/help لعرض الأوامر.`,
  help: () =>
    `<b>الأوامر</b>\n` +
    `/link <code>الكود</code> — ربط حسابك بالكود\n` +
    `/mylinks — آخر ١٠ روابط أرسلتها\n` +
    `/count — عدد روابطك اليوم\n` +
    `/unlink — فك ربط الحساب\n` +
    `/lang — تغيير اللغة (عربي / English)\n\n` +
    `<b>كيف أستخدمه؟</b>\nأرسل رابط الفيديو المنشور مباشرةً (يمكنك إرسال عدة روابط في رسالة واحدة، حتى ${MAX_URLS_PER_MESSAGE}).\n` +
    `المنصات المدعومة: تيك توك، إنستغرام، يوتيوب شورتس، إكس.`,
  notLinked: () => `حسابك غير مربوط بعد. أرسل /link ثم الكود الذي أعطاك إياه المشرف، مثال:\n<code>/link ABCD-EFGH</code>`,
  linkUsage: () => `أرسل الكود بعد الأمر، مثال:\n<code>/link ABCD-EFGH</code>`,
  linkOk: () => `✅ تم ربط حسابك بنجاح!\nالآن أرسل لي رابط أي فيديو نشرته وسأسجّله. (/help للمزيد)`,
  linkInvalid: () => `❌ الكود غير صحيح أو منتهي الصلاحية.\nتأكد من الكود أو اطلب كوداً جديداً من المشرف.`,
  linkAlready: () => `حسابك مربوط بالفعل. إن أردت ربطه بحساب آخر أرسل /unlink أولاً.`,
  linkTooMany: (s) => `⏳ محاولات كثيرة. حاول مرة أخرى بعد ${mins(s)} دقيقة.`,
  linkBusy: () => `⚠️ حدث خطأ مؤقت. أعد المحاولة بعد قليل.`,
  noLinksFound: () =>
    `لم أجد رابطاً في رسالتك 🤔\nأرسل رابط الفيديو بعد نشره (تيك توك / إنستغرام / يوتيوب شورتس / إكس). /help للمساعدة.`,
  accepted: (p, u) => `✅ تم تسجيل ${PLATFORM_LABEL[p]}: ${shortUrl(u)}`,
  duplicate: (u) => `🔁 هذا الرابط مسجّل مسبقاً منك: ${shortUrl(u)}`,
  duplicateOther: (u) => `⚠️ هذا الرابط مسجّل مسبقاً في النظام: ${shortUrl(u)}`,
  unsupported: (u) => `❌ منصة غير مدعومة: ${shortUrl(u)}\nالمدعوم: تيك توك، إنستغرام، يوتيوب شورتس، إكس.`,
  invalid: (u) => `❌ رابط غير صالح: ${shortUrl(u)}\nأرسل رابط الفيديو نفسه (وليس صفحة الحساب أو رابطاً مقتطعاً).`,
  rateLimited: (n, s) => `⏳ لم يتم تسجيل ${n} رابط بسبب الحد المؤقت (${LINKS_PER_WINDOW} رابط كل ${LINKS_WINDOW_SECONDS / 60} دقائق). أعد إرسالها بعد ${mins(s)} دقيقة.`,
  itemError: (u) => `⚠️ تعذّر تسجيل: ${shortUrl(u)} — أعد المحاولة.`,
  ignored: (n) => `ℹ️ تم تجاهل ${n} رابط زائد (الحد ${MAX_URLS_PER_MESSAGE} رابط في الرسالة). أعد إرسالها في رسالة أخرى.`,
  repeated: (n) => `ℹ️ ${n} رابط مكرر في نفس الرسالة تم احتسابه مرة واحدة.`,
  todayTotal: (n) => `📊 عدد روابطك اليوم: ${n}`,
  campaignAuto: (name) => `📌 الحملة: ${esc(name)}`,
  campaignAsk: () => `لأي حملة هذه الروابط؟ اختر من الأزرار:`,
  campaignChosen: (name) => `✅ تم ربط الروابط بحملة: ${esc(name)}`,
  choiceExpired: () => `انتهت صلاحية هذا الخيار أو سبق استخدامه.`,
  myLinksHeader: () => `🗂 <b>آخر روابطك</b>`,
  myLinksEmpty: () => `لا توجد روابط مسجّلة بعد.`,
  myLinkLine: (p, u, s, w) => `${PLATFORM_LABEL[p as Platform] ?? esc(p)} — ${shortUrl(u, 45)}\n   ${ar.status(s)}${w ? " · أُرسل إلى Whop ✅" : ""}`,
  status: (s) => (s === "verified" ? "✔️ تم التحقق" : s === "disputed" ? "⛔ متنازع عليه" : "⏳ قيد المراجعة"),
  count: (n) => `📊 عدد الروابط التي أرسلتها اليوم: <b>${n}</b> (بتوقيت UTC)`,
  unlinkAsk: () => `هل تريد فعلاً فك ربط حسابك؟\nلن تتمكن من إرسال روابط حتى تربطه مجدداً بكود جديد.`,
  unlinkYes: () => `نعم، فك الربط`,
  unlinkNo: () => `إلغاء`,
  unlinkDone: () => `تم فك الربط. لإعادة الربط اطلب كوداً جديداً من المشرف.`,
  unlinkCancelled: () => `تم الإلغاء. حسابك ما زال مربوطاً.`,
  unlinkNotLinked: () => `حسابك غير مربوط أصلاً.`,
  langSet: () => `🌐 تم تغيير اللغة إلى العربية.`,
  tempError: () => `⚠️ حدث خطأ مؤقت. أعد المحاولة بعد قليل.`,
};

const en: Dict = {
  welcomeNew: () =>
    `Welcome to the link intake bot 👋\n\n` +
    `Send me the links to your posted videos (TikTok, Instagram, YouTube Shorts, X) and I'll record them.\n\n` +
    `To get started, link your account with the code the admin gave you:\n<code>/link ABCD-EFGH</code>\n\n` +
    `Type /help for all commands.`,
  welcomeBack: () => `Welcome back ✅ Your account is linked. Send me a video link after you post it.\n/help for commands.`,
  help: () =>
    `<b>Commands</b>\n` +
    `/link <code>CODE</code> — link your account with a code\n` +
    `/mylinks — your last 10 links\n` +
    `/count — how many links you sent today\n` +
    `/unlink — unlink your account\n` +
    `/lang — switch language (عربي / English)\n\n` +
    `<b>How to use</b>\nJust send the link of the posted video (you can send several in one message, up to ${MAX_URLS_PER_MESSAGE}).\n` +
    `Supported: TikTok, Instagram, YouTube Shorts, X.`,
  notLinked: () => `Your account isn't linked yet. Send /link followed by the code the admin gave you, e.g.\n<code>/link ABCD-EFGH</code>`,
  linkUsage: () => `Send the code after the command, e.g.\n<code>/link ABCD-EFGH</code>`,
  linkOk: () => `✅ Your account is linked!\nNow send me the link of any video you posted and I'll record it. (/help for more)`,
  linkInvalid: () => `❌ That code is invalid or has expired.\nCheck it, or ask the admin for a new one.`,
  linkAlready: () => `Your account is already linked. To link a different one, send /unlink first.`,
  linkTooMany: (s) => `⏳ Too many attempts. Try again in ${mins(s)} min.`,
  linkBusy: () => `⚠️ A temporary error occurred. Please try again shortly.`,
  noLinksFound: () =>
    `I couldn't find a link in your message 🤔\nSend the link of your posted video (TikTok / Instagram / YouTube Shorts / X). /help for help.`,
  accepted: (p, u) => `✅ Recorded ${PLATFORM_LABEL[p]}: ${shortUrl(u)}`,
  duplicate: (u) => `🔁 You already submitted this link: ${shortUrl(u)}`,
  duplicateOther: (u) => `⚠️ This link was already submitted: ${shortUrl(u)}`,
  unsupported: (u) => `❌ Unsupported platform: ${shortUrl(u)}\nSupported: TikTok, Instagram, YouTube Shorts, X.`,
  invalid: (u) => `❌ Not a valid post link: ${shortUrl(u)}\nSend the video's own link (not a profile page or a shortened fragment).`,
  rateLimited: (n, s) => `⏳ ${n} link(s) were not recorded because of the temporary limit (${LINKS_PER_WINDOW} per ${LINKS_WINDOW_SECONDS / 60} min). Resend them in ${mins(s)} min.`,
  itemError: (u) => `⚠️ Couldn't record: ${shortUrl(u)} — please retry.`,
  ignored: (n) => `ℹ️ Ignored ${n} extra link(s) (max ${MAX_URLS_PER_MESSAGE} per message). Send them in another message.`,
  repeated: (n) => `ℹ️ ${n} repeated link(s) in the same message counted once.`,
  todayTotal: (n) => `📊 Your links today: ${n}`,
  campaignAuto: (name) => `📌 Campaign: ${esc(name)}`,
  campaignAsk: () => `Which campaign are these links for? Pick one:`,
  campaignChosen: (name) => `✅ Links assigned to campaign: ${esc(name)}`,
  choiceExpired: () => `This choice has expired or was already used.`,
  myLinksHeader: () => `🗂 <b>Your latest links</b>`,
  myLinksEmpty: () => `No links recorded yet.`,
  myLinkLine: (p, u, s, w) => `${PLATFORM_LABEL[p as Platform] ?? esc(p)} — ${shortUrl(u, 45)}\n   ${en.status(s)}${w ? " · sent to Whop ✅" : ""}`,
  status: (s) => (s === "verified" ? "✔️ Verified" : s === "disputed" ? "⛔ Disputed" : "⏳ Pending review"),
  count: (n) => `📊 Links you sent today: <b>${n}</b> (UTC)`,
  unlinkAsk: () => `Do you really want to unlink your account?\nYou won't be able to send links until you link again with a new code.`,
  unlinkYes: () => `Yes, unlink`,
  unlinkNo: () => `Cancel`,
  unlinkDone: () => `Unlinked. Ask the admin for a new code to link again.`,
  unlinkCancelled: () => `Cancelled. Your account is still linked.`,
  unlinkNotLinked: () => `Your account isn't linked.`,
  langSet: () => `🌐 Language set to English.`,
  tempError: () => `⚠️ A temporary error occurred. Please try again shortly.`,
};

export function t(lang: Lang): Dict {
  return lang === "en" ? en : ar;
}

export { BOT_USERNAME };
