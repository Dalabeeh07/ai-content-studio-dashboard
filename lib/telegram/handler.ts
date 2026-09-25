import type { BotApi, InlineKeyboard } from "./api";
import {
  BOT_USERNAME, CAMPAIGN_WINDOW_HOURS, CHOICE_TTL_SECONDS, DAY_WINDOW_SECONDS,
  LINK_ATTEMPTS_GLOBAL, LINK_ATTEMPTS_GLOBAL_WINDOW_SECONDS, LINK_ATTEMPTS_PER_USER,
  LINK_ATTEMPTS_WINDOW_SECONDS, LINKS_PER_DAY, LINKS_PER_WINDOW, LINKS_WINDOW_SECONDS,
  MAX_CAMPAIGN_CHOICES, MAX_URLS_PER_MESSAGE, MESSAGES_PER_WINDOW, MESSAGES_WINDOW_SECONDS,
} from "./config";
import { newChoiceToken, normalizeLinkCode } from "./codes";
import { detectLang, plainLabel, t } from "./messages";
import type { Store, SubmitItem, UserContext } from "./store";
import type { Lang, TgCallbackQuery, TgMessage, TgUpdate } from "./types";
import { extractFromMessage } from "./url";

export interface HandlerDeps {
  store: Store;
  bot: BotApi;
  /** Keyed hash of a normalised link code (throws if the secret is missing). */
  hashCode: (code: string) => string;
  now?: () => Date;
}

const MAX_REPLY_CHARS = 3800; // Telegram's hard cap is 4096; leave headroom

// Join whole lines only, never cutting mid-line: slicing escaped HTML
// ("&amp;") in half would make Telegram reject the entire reply.
function joinWithinLimit(lines: string[], max = MAX_REPLY_CHARS): string {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max) break;
    out.push(l);
    len += l.length + 1;
  }
  return out.join("\n");
}

export async function handleUpdate(update: TgUpdate, deps: HandlerDeps): Promise<void> {
  if (update.message) return handleMessage(update, update.message, deps);
  if (update.callback_query) return handleCallback(update.callback_query, deps);
}

// ── Messages ────────────────────────────────────────────────────────────────

interface Command { name: string; args: string }

function parseCommand(msg: TgMessage): Command | "foreign" | null {
  const text = (msg.text ?? "").trimStart();
  if (!text.startsWith("/")) return null;
  const first = text.split(/\s+/, 1)[0];
  const [rawName, botSuffix] = first.slice(1).split("@", 2);
  if (botSuffix !== undefined && botSuffix.toLowerCase() !== BOT_USERNAME.toLowerCase()) return "foreign";
  return { name: rawName.toLowerCase().slice(0, 32), args: text.slice(first.length).trim().slice(0, 200) };
}

async function handleMessage(update: TgUpdate, msg: TgMessage, deps: HandlerDeps): Promise<void> {
  const { store, bot } = deps;
  const from = msg.from!;
  const uid = from.id;
  const chatId = msg.chat.id;

  // Cheap per-user message ceiling (cost/reply-spam guard). Over it we stay
  // SILENT - answering an abuser is exactly what they want.
  const mr = await store.rateConsume(`msg:${uid}`, MESSAGES_WINDOW_SECONDS, MESSAGES_PER_WINDOW, 1);
  if (mr.granted < 1) return;

  const ctx = await store.getContext(uid, from.username ?? null);
  const lang: Lang = ctx.language ?? detectLang(from.language_code);
  const m = t(lang);
  const send = (text: string, kb?: InlineKeyboard) => bot.sendMessage(chatId, text, kb);

  try {
    const cmd = parseCommand(msg);
    if (cmd === "foreign") return; // addressed to a different bot
    if (cmd) {
      await handleCommand(cmd, msg, ctx, lang, deps);
      return;
    }
    await handleSubmission(update, msg, ctx, lang, deps);
  } catch (err) {
    console.error(`telegram: handler error: ${err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : "unknown"}`);
    await send(m.tempError());
    throw err; // let the route mark the update failed
  }
}

async function handleCommand(cmd: Command, msg: TgMessage, ctx: UserContext, lang: Lang, deps: HandlerDeps): Promise<void> {
  const { store, bot } = deps;
  const from = msg.from!;
  const uid = from.id;
  const chatId = msg.chat.id;
  const m = t(lang);
  const send = (text: string, kb?: InlineKeyboard) => bot.sendMessage(chatId, text, kb);

  switch (cmd.name) {
    case "start": {
      // Deep link t.me/<bot>?start=<CODE> arrives as "/start <CODE>".
      if (cmd.args && normalizeLinkCode(cmd.args) && !ctx.linked) return doLink(cmd.args, msg, ctx, lang, deps);
      await send(ctx.linked ? m.welcomeBack() : m.welcomeNew());
      return;
    }
    case "help":
      await send(m.help());
      return;
    case "link":
      return doLink(cmd.args, msg, ctx, lang, deps);
    case "mylinks": {
      if (!ctx.linked || !ctx.hwid) { await send(m.notLinked()); return; }
      const rows = await store.myLinks(ctx.hwid, 10);
      if (rows.length === 0) { await send(m.myLinksEmpty()); return; }
      await send(joinWithinLimit([m.myLinksHeader(), "", ...rows.map((r) => m.myLinkLine(r.platform, r.videoUrl, r.status, r.whopSubmittedAt !== null))]));
      return;
    }
    case "count": {
      if (!ctx.linked) { await send(m.notLinked()); return; }
      await send(m.count(await store.todayCount(uid)));
      return;
    }
    case "unlink": {
      if (!ctx.linked) { await send(m.unlinkNotLinked()); return; }
      const token = newChoiceToken();
      await store.createChoice("unlink", uid, chatId, token, {}, CHOICE_TTL_SECONDS);
      await send(m.unlinkAsk(), [[
        { text: plainLabel(m.unlinkYes()), callback_data: `u:${token}:1` },
        { text: plainLabel(m.unlinkNo()), callback_data: `u:${token}:0` },
      ]]);
      return;
    }
    case "lang": {
      const arg = cmd.args.toLowerCase();
      let target: Lang;
      if (/^(ar|arabic|عربي|العربية|عربى)$/.test(arg)) target = "ar";
      else if (/^(en|english|انجليزي|إنجليزي|الانجليزية|الإنجليزية)$/.test(arg)) target = "en";
      else target = lang === "ar" ? "en" : "ar"; // no/unknown arg: toggle
      await store.setLanguage(uid, from.username ?? null, target);
      await send(t(target).langSet());
      return;
    }
    default:
      await send(m.help());
  }
}

// ── /link ───────────────────────────────────────────────────────────────────

async function doLink(argsText: string, msg: TgMessage, ctx: UserContext, lang: Lang, deps: HandlerDeps): Promise<void> {
  const { store, bot } = deps;
  const from = msg.from!;
  const uid = from.id;
  const m = t(lang);
  const send = (text: string) => bot.sendMessage(msg.chat.id, text);

  // A linked account is refused BEFORE spending an attempt or touching a code,
  // so it can neither probe nor burn other people's codes.
  if (ctx.linked) { await send(m.linkAlready()); return; }
  if (!argsText.trim()) { await send(m.linkUsage()); return; }

  const code = normalizeLinkCode(argsText);
  if (!code) { await send(m.linkInvalid()); return; } // malformed: never reaches the DB

  // Brute-force protection: per account AND global (an attacker rotating
  // throwaway accounts still hits the aggregate ceiling).
  const perUser = await store.rateConsume(`linkatt:${uid}`, LINK_ATTEMPTS_WINDOW_SECONDS, LINK_ATTEMPTS_PER_USER, 1);
  if (perUser.granted < 1) { await send(m.linkTooMany(perUser.retryAfterSeconds)); return; }
  const global = await store.rateConsume("linkatt:global", LINK_ATTEMPTS_GLOBAL_WINDOW_SECONDS, LINK_ATTEMPTS_GLOBAL, 1);
  if (global.granted < 1) { await send(m.linkTooMany(global.retryAfterSeconds)); return; }

  const r = await store.redeemLinkCode(deps.hashCode(code), uid, from.username ?? null, lang);
  if (r.ok) { await send(m.linkOk()); return; }
  if (r.reason === "already_linked") { await send(m.linkAlready()); return; }
  if (r.reason === "conflict") { await send(m.linkBusy()); return; }
  await send(m.linkInvalid()); // unknown / expired / used / revoked: deliberately indistinguishable
}

// ── Submissions ─────────────────────────────────────────────────────────────

async function handleSubmission(update: TgUpdate, msg: TgMessage, ctx: UserContext, lang: Lang, deps: HandlerDeps): Promise<void> {
  const { store, bot } = deps;
  const from = msg.from!;
  const uid = from.id;
  const chatId = msg.chat.id;
  const m = t(lang);
  const now = deps.now ?? (() => new Date());

  const ex = extractFromMessage(
    { text: msg.text, entities: msg.entities, caption: msg.caption, caption_entities: msg.caption_entities },
    MAX_URLS_PER_MESSAGE,
  );
  const found = ex.accepted.length + ex.rejected.length + ex.ignoredCount;

  if (!ctx.linked || !ctx.hwid) { await bot.sendMessage(chatId, m.notLinked()); return; }
  if (found === 0) { await bot.sendMessage(chatId, m.noLinksFound()); return; }

  // ── Rate limit (only URLs that are real submission attempts consume quota) ──
  let allowed = ex.accepted.length;
  let limitedRetry = 0;
  if (allowed > 0) {
    const day = await store.rateConsume(`urls:day:${uid}`, DAY_WINDOW_SECONDS, LINKS_PER_DAY, allowed);
    let granted = day.granted;
    if (granted < allowed) limitedRetry = day.retryAfterSeconds;
    if (granted > 0) {
      const win = await store.rateConsume(`urls:win:${uid}`, LINKS_WINDOW_SECONDS, LINKS_PER_WINDOW, granted);
      if (win.granted < granted) {
        await store.rateRefund(`urls:day:${uid}`, granted - win.granted); // don't charge the day for what the window refused
        if (limitedRetry === 0) limitedRetry = win.retryAfterSeconds;
        granted = win.granted;
      }
    }
    allowed = granted;
  }
  const toProcess = ex.accepted.slice(0, allowed);
  const refused = ex.accepted.length - toProcess.length;

  // ── Campaign attribution ──
  let campaignId: string | null = null;
  let options: { campaignId: string; name: string }[] = [];
  let autoCampaignName: string | null = null;
  if (toProcess.length > 0) {
    const since = new Date(now().getTime() - CAMPAIGN_WINDOW_HOURS * 3600_000).toISOString();
    const recent = await store.recentCampaigns(ctx.hwid, since, MAX_CAMPAIGN_CHOICES + 1);
    if (recent.length === 1) {
      campaignId = recent[0].campaignId;
      autoCampaignName = recent[0].name;
    } else if (recent.length >= 2) {
      options = recent.slice(0, MAX_CAMPAIGN_CHOICES).map((c) => ({ campaignId: c.campaignId, name: c.name }));
    }
  }

  // ── Save ──
  const lines: string[] = [];
  const acceptedIds: string[] = [];
  let todayCount: number | null = null;
  if (toProcess.length > 0) {
    const items: SubmitItem[] = toProcess.map((u) => ({
      video_url: u.videoUrl, canonical_url: u.canonicalUrl, platform: u.platform,
      username: u.usernameHint ?? "", opaque: u.opaque,
    }));
    const res = await store.submitLinks(uid, update.update_id, campaignId, items);
    if (!res.ok) { await bot.sendMessage(chatId, m.notLinked()); return; }
    todayCount = res.todayCount;
    const byCanonical = new Map(res.results.map((r) => [r.canonicalUrl, r]));
    for (const u of toProcess) {
      const r = byCanonical.get(u.canonicalUrl);
      switch (r?.outcome) {
        case "accepted": lines.push(m.accepted(u.platform, u.videoUrl)); if (r.id) acceptedIds.push(r.id); break;
        case "duplicate": lines.push(m.duplicate(u.videoUrl)); break;
        case "duplicate_other": lines.push(m.duplicateOther(u.videoUrl)); break;
        default: lines.push(m.itemError(u.videoUrl));
      }
    }
  }

  // Rejected candidates: cap the noise (each carries an explanation line).
  for (const r of ex.rejected.slice(0, 5)) lines.push(r.reason === "unsupported_platform" ? m.unsupported(r.raw) : m.invalid(r.raw));
  if (ex.rejected.length > 5) lines.push(`… +${ex.rejected.length - 5}`);
  if (refused > 0) lines.push(m.rateLimited(refused, limitedRetry));
  if (ex.ignoredCount > 0) lines.push(m.ignored(ex.ignoredCount));
  if (ex.repeatedInMessage > 0) lines.push(m.repeated(ex.repeatedInMessage));
  if (autoCampaignName && acceptedIds.length > 0) lines.push(m.campaignAuto(autoCampaignName));
  if (todayCount !== null) lines.push(m.todayTotal(todayCount));

  // ── Ambiguous campaign: ask, with a single-use token bound to user + chat ──
  let keyboard: InlineKeyboard | undefined;
  if (options.length >= 2 && acceptedIds.length > 0) {
    try {
      const token = newChoiceToken();
      await store.createChoice("campaign", uid, chatId, token, {
        options: options.map((o) => ({ campaign_id: o.campaignId, name: o.name })),
        submission_ids: acceptedIds,
      }, CHOICE_TTL_SECONDS);
      keyboard = options.map((o, i) => [{ text: plainLabel(o.name), callback_data: `c:${token}:${i}` }]);
      lines.push("", m.campaignAsk());
    } catch (err) {
      // The links are already saved; the founder can assign the campaign later.
      console.error(`telegram: could not create campaign picker: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }
  await bot.sendMessage(chatId, joinWithinLimit(lines), keyboard);
}

// ── Callback queries (inline keyboards) ─────────────────────────────────────

const CALLBACK_RE = /^([cu]):([0-9a-f]{16}):([0-9])$/;

async function handleCallback(cq: TgCallbackQuery, deps: HandlerDeps): Promise<void> {
  const { store, bot } = deps;
  const uid = cq.from.id;

  // Buttons only ever exist in private chats we posted them in.
  if (!cq.message || cq.message.chat.type !== "private" || cq.message.chat.id !== uid) {
    await bot.answerCallbackQuery(cq.id);
    return;
  }
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;

  const mr = await store.rateConsume(`msg:${uid}`, MESSAGES_WINDOW_SECONDS, MESSAGES_PER_WINDOW, 1);
  if (mr.granted < 1) { await bot.answerCallbackQuery(cq.id); return; }

  const ctx = await store.getContext(uid, cq.from.username ?? null);
  const lang: Lang = ctx.language ?? detectLang(cq.from.language_code);
  const m = t(lang);

  const match = CALLBACK_RE.exec(cq.data ?? "");
  if (!match) { await bot.answerCallbackQuery(cq.id); return; }
  const [, kind, token, arg] = match;

  if (kind === "c") {
    const r = await store.applyCampaignChoice(token, uid, chatId, Number(arg));
    if (r.ok) {
      await bot.answerCallbackQuery(cq.id);
      await bot.editMessageText(chatId, messageId, m.campaignChosen(r.campaignName ?? ""));
    } else {
      await bot.answerCallbackQuery(cq.id, m.choiceExpired());
    }
    return;
  }

  // kind === "u": unlink confirmation. arg "1" = yes, "0" = cancel. Either way
  // the token is consumed, so a confirmation can be acted on exactly once.
  const okToken = await store.consumeChoice(token, "unlink", uid, chatId);
  if (!okToken) { await bot.answerCallbackQuery(cq.id, m.choiceExpired()); return; }
  await bot.answerCallbackQuery(cq.id);
  if (arg === "1") {
    const n = await store.unlink(uid);
    await bot.editMessageText(chatId, messageId, n > 0 ? m.unlinkDone() : m.unlinkNotLinked());
  } else {
    await bot.editMessageText(chatId, messageId, m.unlinkCancelled());
  }
}

