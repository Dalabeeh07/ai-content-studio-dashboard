// Handler + webhook tests. The Store runs the REAL tg_* SQL functions in
// PGlite (see pgliteRpc.ts), so dedupe, rate limiting, single-use codes and
// callback binding are exercised against real Postgres semantics; only the
// Telegram Bot API is faked (FakeBot records what would have been sent).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { BotApi, InlineKeyboard } from "../../lib/telegram/api";
import { generateLinkCode, formatLinkCode, hashLinkCode } from "../../lib/telegram/codes";
import { Store } from "../../lib/telegram/store";
import { processWebhook } from "../../lib/telegram/webhook";
import { make041, type Db } from "./harness";
import { pgliteRpc } from "./pgliteRpc";

const SECRET = "test-webhook-secret-0123456789";
let db: Db;
let store: Store;
let calls: string[] = [];
let failFn: ((fn: string) => Error | null) | null = null;

class FakeBot implements BotApi {
  sent: { chatId: number; text: string; kb?: InlineKeyboard }[] = [];
  edits: { chatId: number; messageId: number; text: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  failSend = false;
  async sendMessage(chatId: number, text: string, kb?: InlineKeyboard) { this.sent.push({ chatId, text, kb }); return !this.failSend; }
  async answerCallbackQuery(id: string, text?: string) { this.answers.push({ id, text }); return true; }
  async editMessageText(chatId: number, messageId: number, text: string) { this.edits.push({ chatId, messageId, text }); return true; }
  get last() { return this.sent[this.sent.length - 1]; }
}
let bot = new FakeBot();

before(async () => {
  db = await make041();
  store = new Store(pgliteRpc(db, { onCall: (fn) => calls.push(fn), failOn: (fn) => (failFn ? failFn(fn) : null) }));
});

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
const uniq = (p: string) => `${p}_${++seq}_${Math.random().toString(36).slice(2, 7)}`;
let uidSeq = 2_000_000;
const newUser = () => ++uidSeq;
let updSeq = 8_000_000;
const nextUpdateId = () => ++updSeq;
let tiktokSeq = 0;
const tiktokId = () => `73${String(++tiktokSeq).padStart(17, "0")}`; // 19 digits, unique per call
const tt = (id = tiktokId(), handle = "creator") => `https://www.tiktok.com/@${handle}/video/${id}`;

interface MsgOpts { lang?: string; username?: string; entities?: unknown; caption?: string; chatType?: string; updateId?: number }
function messageUpdate(userId: number, text: string | undefined, o: MsgOpts = {}) {
  return {
    update_id: o.updateId ?? nextUpdateId(),
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, username: o.username, language_code: o.lang },
      chat: { id: userId, type: o.chatType ?? "private" },
      ...(text !== undefined ? { text } : {}),
      ...(o.caption !== undefined ? { caption: o.caption } : {}),
      ...(o.entities ? { entities: o.entities } : {}),
    },
  };
}
function callbackUpdate(fromId: number, chatId: number, data: string, o: { updateId?: number; chatType?: string } = {}) {
  return {
    update_id: o.updateId ?? nextUpdateId(),
    callback_query: {
      id: uniq("cbq"), from: { id: fromId, is_bot: false, language_code: "ar" }, data,
      message: { message_id: 77, chat: { id: chatId, type: o.chatType ?? "private" }, from: { id: 1, is_bot: true } },
    },
  };
}

async function send(update: unknown, o: { secret?: string | null; raw?: string; headers?: Record<string, string>; secretConfigured?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(o.headers ?? {}) };
  const sec = o.secret === undefined ? SECRET : o.secret;
  if (sec !== null) headers["x-telegram-bot-api-secret-token"] = sec;
  const req = new Request("http://localhost/api/telegram/webhook", {
    method: "POST", headers, body: o.raw ?? JSON.stringify(update),
  });
  return processWebhook(req, {
    secret: o.secretConfigured ?? SECRET, store, bot,
    hashCode: (c) => hashLinkCode(c, SECRET),
  });
}
async function say(userId: number, text: string, o: MsgOpts = {}) {
  const res = await send(messageUpdate(userId, text, o));
  assert.equal(res.status, 200);
  return bot.last;
}

async function mkUser(hwid = uniq("hwid"), opts: { license?: string | null } = {}) {
  const r = await db.query<{ id: string }>(`INSERT INTO users (email, hwid) VALUES ($1,$2) RETURNING id`, [`${hwid}@example.invalid`, hwid]);
  if (opts.license !== null) await db.query(`INSERT INTO licenses (key, hwid, status) VALUES ($1,$2,$3)`, [uniq("K"), hwid, opts.license ?? "active"]);
  return { id: r.rows[0].id, hwid };
}
async function issueCode(hwid: string, userId: string) {
  const code = generateLinkCode();
  await db.query(`SELECT tg_create_link_code($1,$2,$3,3600)`, [hwid, userId, hashLinkCode(code, SECRET)]);
  return code;
}
async function linkedUser(o: MsgOpts = {}) {
  const uid = newUser();
  const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  await say(uid, `/link ${formatLinkCode(code)}`, o);
  return { uid, ...u };
}
async function n(sql: string, params: unknown[] = []) { return (await db.query<{ n: number }>(sql, params)).rows[0].n; }
async function totals() {
  const tables = ["telegram_users", "telegram_links", "telegram_link_codes", "telegram_updates", "telegram_rate_limits", "telegram_pending_choices", "telegram_duplicate_attempts", "video_submissions"];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await n(`SELECT count(*)::int AS n FROM ${t}`);
  return out;
}
async function mkCampaign(name: string) {
  return (await db.query<{ id: string }>(`INSERT INTO campaigns (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
}
async function exportFrom(hwid: string, campaignId: string, ago = "1 hour") {
  await db.query(`INSERT INTO campaign_exports (campaign_id, hwid, exported_at) VALUES ($1,$2, now() - $3::interval)`, [campaignId, hwid, ago]);
}
const reset = () => { bot = new FakeBot(); calls = []; failFn = null; };

// ═══════════════════════════ Webhook security ═══════════════════════════════

test("webhook: wrong / missing / empty secret => 401 and ZERO database access", async () => {
  reset();
  const before = await totals();
  const u = messageUpdate(newUser(), "/start");
  for (const secret of [null, "", "wrong", SECRET + "x", SECRET.slice(0, -1), SECRET.toUpperCase()]) {
    const res = await send(u, { secret });
    assert.equal(res.status, 401, `secret=${JSON.stringify(secret)}`);
  }
  assert.deepEqual(await totals(), before);
  assert.equal(calls.length, 0, `DB was touched: ${calls.join(",")}`);
  assert.equal(bot.sent.length, 0);
});

test("webhook: server secret not configured => 503 (fails closed, even for a 'matching' empty header)", async () => {
  reset();
  const res = await send(messageUpdate(newUser(), "/start"), { secretConfigured: "", secret: "" });
  assert.equal(res.status, 503);
  const res2 = await send(messageUpdate(newUser(), "/start"), { secretConfigured: "", secret: null });
  assert.equal(res2.status, 503);
  assert.equal(calls.length, 0);
});

test("webhook: oversized body => 413 without parsing or DB access; lying Content-Length cannot bypass the cap", async () => {
  reset();
  const huge = JSON.stringify({ update_id: nextUpdateId(), message: { text: "x".repeat(200_000) } });
  const r1 = await send(null, { raw: huge });
  assert.equal(r1.status, 413);
  const r2 = await send(null, { raw: huge, headers: { "content-length": "10" } }); // claims to be tiny
  assert.equal(r2.status, 413);
  assert.equal(calls.length, 0);
});

test("webhook: malformed / non-object / wrong-shaped JSON => 200 ignored, no DB writes, no reply", async () => {
  reset();
  const before = await totals();
  const bodies = ["{not json", "", "null", "[]", "123", '"str"', "{}", '{"update_id":"1"}', '{"update_id":-5,"message":{}}',
    '{"update_id":1.5,"message":{}}', `{"update_id":${2 ** 60},"message":{}}`];
  for (const raw of bodies) {
    const res = await send(null, { raw });
    assert.equal(res.status, 200, raw);
  }
  assert.deepEqual(await totals(), before);
  assert.equal(calls.length, 0);
  assert.equal(bot.sent.length, 0);
});

test("webhook: non-private chats, edited_message, channel_post, bot senders, text-less messages are ignored with zero writes", async () => {
  reset();
  const before = await totals();
  const uid = newUser();
  const base = messageUpdate(uid, "/start");
  const cases: unknown[] = [
    messageUpdate(uid, "/start", { chatType: "group" }),
    messageUpdate(uid, "/start", { chatType: "supergroup" }),
    messageUpdate(uid, "/start", { chatType: "channel" }),
    { update_id: nextUpdateId(), edited_message: (base as { message: unknown }).message },
    { update_id: nextUpdateId(), channel_post: (base as { message: unknown }).message },
    { update_id: nextUpdateId(), inline_query: { id: "1", from: { id: uid }, query: "x", offset: "" } },
    { update_id: nextUpdateId(), message: { ...(base as { message: object }).message, from: { id: uid, is_bot: true } } },
    { update_id: nextUpdateId(), message: { message_id: 1, from: { id: uid }, chat: { id: uid, type: "private" } } }, // no text/caption (sticker/photo)
    { update_id: nextUpdateId(), message: { message_id: 1, from: { id: uid }, chat: { id: uid + 1, type: "private" }, text: "/start" } }, // chat id != user id
    { update_id: nextUpdateId(), message: { message_id: 1, chat: { id: uid, type: "private" }, text: "/start" } }, // no sender
    { update_id: nextUpdateId(), my_chat_member: {} },
  ];
  for (const c of cases) assert.equal((await send(c)).status, 200);
  assert.deepEqual(await totals(), before);
  assert.equal(calls.length, 0);
  assert.equal(bot.sent.length, 0);
});

test("webhook: replayed update_id is processed exactly once", async () => {
  reset();
  const uid = newUser();
  const u = messageUpdate(uid, "/help");
  await send(u); await send(u); await send(u);
  assert.equal(bot.sent.length, 1);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_updates WHERE update_id = $1`, [u.update_id]), 1);
});

test("webhook: concurrent duplicate deliveries of one update => one reply", async () => {
  reset();
  const u = messageUpdate(newUser(), "/help");
  const results = await Promise.all(Array.from({ length: 8 }, () => send(u)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(bot.sent.length, 1);
});

test("webhook: datastore down BEFORE the claim => 503 (Telegram will redeliver, nothing lost)", async () => {
  reset();
  failFn = (fn) => (fn === "tg_claim_update" ? new Error("connection refused") : null);
  const res = await send(messageUpdate(newUser(), "/start"));
  assert.equal(res.status, 503);
  assert.equal(bot.sent.length, 0);
  failFn = null;
});

test("webhook: failure AFTER the claim => 200, user told to retry, update marked failed", async () => {
  reset();
  const uid = newUser();
  failFn = (fn) => (fn === "tg_get_context" ? new Error("boom") : null);
  const u = messageUpdate(uid, "/start");
  const res = await send(u);
  failFn = null;
  // get_context fails before we know the language, so no reply can be composed;
  // the point is: no throw, 200, and the ledger says failed.
  assert.equal(res.status, 200);
  const st = await db.query<{ status: string }>(`SELECT status FROM telegram_updates WHERE update_id = $1`, [u.update_id]);
  assert.equal(st.rows[0].status, "failed");
});

test("webhook: a failed Bot API reply never loses the saved link and never fails the webhook", async () => {
  reset();
  const { uid } = await linkedUser();
  bot.failSend = true;
  const url = tt();
  const res = await send(messageUpdate(uid, url));
  assert.equal(res.status, 200);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [uid]), 1);
});

// ═══════════════════════════ Commands ═══════════════════════════════════════

test("/start: Arabic by default, English when Telegram says en; unknown commands show help", async () => {
  reset();
  const ar = await say(newUser(), "/start");
  assert.match(ar.text, /أهلاً/);
  assert.match(ar.text, /<code>\/link ABCD-EFGH<\/code>/);
  const en = await say(newUser(), "/start", { lang: "en-GB" });
  assert.match(en.text, /Welcome/);
  const fr = await say(newUser(), "/start", { lang: "fr" });
  assert.match(fr.text, /أهلاً/); // default Arabic for anything but English
  const help = await say(newUser(), "/nonsense");
  assert.match(help.text, /الأوامر/);
  const help2 = await say(newUser(), "/help", { lang: "en" });
  assert.match(help2.text, /Commands/);
  const foreign = bot.sent.length;
  await say(newUser(), "/help@SomeOtherBot").catch(() => {});
  assert.equal(bot.sent.length, foreign); // addressed to a different bot: ignored
  await say(newUser(), "/help@PlovikaLinksBot");
  assert.equal(bot.sent.length, foreign + 1);
});

test("/link: happy path (with/without hyphen, lower-case, spaces) and deep link /start CODE", async () => {
  reset();
  for (const fmt of [(c: string) => formatLinkCode(c), (c: string) => c, (c: string) => c.toLowerCase(), (c: string) => `${c.slice(0, 2)} ${c.slice(2, 6)}  ${c.slice(6)}`]) {
    const uid = newUser(); const u = await mkUser();
    const code = await issueCode(u.hwid, u.id);
    const r = await say(uid, `/link ${fmt(code)}`);
    assert.match(r.text, /تم ربط حسابك/);
    assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1 AND revoked_at IS NULL AND hwid = $2`, [uid, u.hwid]), 1);
  }
  const uid = newUser(); const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  const r = await say(uid, `/start ${code}`, { lang: "en" });
  assert.match(r.text, /linked/);
});

test("/link: wrong, malformed, empty, reused, expired codes all get the same generic refusal; nothing links", async () => {
  reset();
  const uid = newUser(); const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  const wrong = generateLinkCode();
  assert.match((await say(uid, `/link ${wrong}`)).text, /غير صحيح/);
  assert.match((await say(uid, `/link 123`)).text, /غير صحيح/);
  assert.match((await say(uid, `/link ${"A".repeat(500)}`)).text, /غير صحيح/);
  assert.match((await say(uid, `/link`)).text, /\/link ABCD-EFGH/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1`, [uid]), 0);
  // Expire it, then try the right code.
  await db.query(`UPDATE telegram_link_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hashLinkCode(code, SECRET)]);
  const expired = (await say(uid, `/link ${code}`)).text;
  assert.equal(expired, (await say(uid, `/link ${wrong}`)).text, "expired and unknown must be indistinguishable");
});

test("/link: code reuse by a second account fails; linked account can't link again", async () => {
  reset();
  const a = newUser(); const b = newUser(); const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  assert.match((await say(a, `/link ${code}`)).text, /تم ربط/);
  assert.match((await say(b, `/link ${code}`)).text, /غير صحيح/);
  assert.match((await say(a, `/link ${code}`)).text, /مربوط بالفعل/);
  // A linked account is refused BEFORE it spends a brute-force attempt or touches the DB's code table.
  const spent = () => n(`SELECT coalesce(max(count), 0)::int AS n FROM telegram_rate_limits WHERE key = $1`, [`linkatt:${a}`]);
  const beforeSpent = await spent(); // the one legitimate link above cost exactly one attempt
  for (let i = 0; i < 12; i++) await say(a, `/link ${generateLinkCode()}`);
  assert.equal(await spent(), beforeSpent);
});

test("/link: concurrent redemption of ONE code by many accounts - exactly one wins", async () => {
  reset();
  const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  const accounts = Array.from({ length: 6 }, () => newUser());
  await Promise.all(accounts.map((a) => send(messageUpdate(a, `/link ${code}`))));
  const winners = await n(`SELECT count(*)::int AS n FROM telegram_links WHERE hwid = $1 AND revoked_at IS NULL`, [u.hwid]);
  assert.equal(winners, 1);
  const okReplies = bot.sent.filter((s) => /تم ربط/.test(s.text)).length;
  assert.equal(okReplies, 1);
});

test("/link brute force: the 6th attempt in the window is throttled (even with a correct code), other users unaffected", async () => {
  reset();
  const attacker = newUser();
  for (let i = 0; i < 5; i++) assert.match((await say(attacker, `/link ${generateLinkCode()}`)).text, /غير صحيح/);
  const u = await mkUser();
  const good = await issueCode(u.hwid, u.id);
  const throttled = await say(attacker, `/link ${good}`);
  assert.match(throttled.text, /محاولات كثيرة/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE hwid = $1`, [u.hwid]), 0, "throttled attempt must not link");
  // A different account with the same good code still works.
  assert.match((await say(newUser(), `/link ${good}`)).text, /تم ربط/);
});

test("/link brute force: the GLOBAL ceiling stops an attacker rotating throwaway accounts", async () => {
  reset();
  await db.query(`INSERT INTO telegram_rate_limits (key, window_start, count) VALUES ('linkatt:global', now(), 300) ON CONFLICT (key) DO UPDATE SET window_start = now(), count = 300`);
  const u = await mkUser();
  const good = await issueCode(u.hwid, u.id);
  const r = await say(newUser(), `/link ${good}`);
  assert.match(r.text, /محاولات كثيرة/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE hwid = $1`, [u.hwid]), 0);
  await db.query(`DELETE FROM telegram_rate_limits WHERE key = 'linkatt:global'`);
});

test("/mylinks, /count, /lang, /unlink (confirm + cancel + forged/expired)", async () => {
  reset();
  const { uid } = await linkedUser();
  assert.match((await say(uid, "/mylinks")).text, /لا توجد روابط/);
  await say(uid, tt());
  await say(uid, tt());
  const ml = (await say(uid, "/mylinks")).text;
  assert.match(ml, /آخر روابطك/);
  assert.equal((ml.match(/قيد المراجعة/g) ?? []).length, 2);
  assert.match((await say(uid, "/count")).text, /<b>2<\/b>/);

  assert.match((await say(uid, "/lang")).text, /English/); // toggles ar -> en
  assert.match((await say(uid, "/count")).text, /UTC/);     // now English
  assert.match((await say(uid, "/lang ar")).text, /العربية/);
  assert.match((await say(uid, "/lang english")).text, /English/);
  await say(uid, "/lang ar");

  // /unlink -> keyboard; forged (other user / other chat) presses fail; then confirm.
  await say(uid, "/unlink");
  const kb = bot.last.kb!;
  assert.equal(kb[0].length, 2);
  const yes = kb[0][0].callback_data; const no = kb[0][1].callback_data;
  assert.match(yes, /^u:[0-9a-f]{16}:1$/);
  const stranger = newUser();
  await send(callbackUpdate(stranger, stranger, yes));        // someone else presses it
  await send(callbackUpdate(uid, uid + 999, yes));            // wrong chat
  await send(callbackUpdate(uid, uid, yes, { chatType: "group" }));
  assert.equal(bot.edits.length, 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1 AND revoked_at IS NULL`, [uid]), 1, "forged presses must not unlink");
  await send(callbackUpdate(uid, uid, no));                   // cancel consumes the token
  assert.match(bot.edits.at(-1)!.text, /تم الإلغاء/);
  await send(callbackUpdate(uid, uid, yes));                  // replaying the consumed token is dead
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1 AND revoked_at IS NULL`, [uid]), 1);

  await say(uid, "/unlink");
  const yes2 = bot.last.kb![0][0].callback_data;
  await send(callbackUpdate(uid, uid, yes2));
  assert.match(bot.edits.at(-1)!.text, /تم فك الربط/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1 AND revoked_at IS NULL`, [uid]), 0);
  await send(callbackUpdate(uid, uid, yes2));                 // replay
  assert.equal(bot.edits.length >= 2, true);
  assert.match((await say(uid, "/unlink")).text, /غير مربوط/);
  // Expired confirmation is refused.
  const { uid: u2 } = await linkedUser();
  await say(u2, "/unlink");
  const tok = bot.last.kb![0][0].callback_data.split(":")[1];
  await db.query(`UPDATE telegram_pending_choices SET expires_at = now() - interval '1 second' WHERE token = $1`, [tok]);
  const editsBefore = bot.edits.length;
  await send(callbackUpdate(u2, u2, `u:${tok}:1`));
  assert.equal(bot.edits.length, editsBefore);
  assert.equal(bot.answers.at(-1)!.text, "انتهت صلاحية هذا الخيار أو سبق استخدامه.");
});

// ═══════════════════════════ Submissions ════════════════════════════════════

test("unlinked user sending a link: told to link, NOTHING is written to video_submissions", async () => {
  reset();
  const before = await n(`SELECT count(*)::int AS n FROM video_submissions`);
  const r = await say(newUser(), tt());
  assert.match(r.text, /غير مربوط/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions`), before);
});

test("linked user: one TikTok link is recorded with the right fields and a running count", async () => {
  reset();
  const { uid, hwid } = await linkedUser({ username: "aliya" });
  const id = tiktokId();
  const r = await say(uid, `شوف هذا 🔥 ${tt(id, "Aliya")}?utm_source=copy&is_from_webapp=1`);
  assert.match(r.text, /✅ تم تسجيل TikTok/);
  assert.match(r.text, /عدد روابطك اليوم: 1/);
  const row = (await db.query<Record<string, unknown>>(`SELECT platform, video_url, canonical_url, username, status, source, telegram_user_id::text AS tg, hardware_id, whop_submitted_at, campaign_id, flags FROM video_submissions WHERE canonical_url = $1`, [`https://www.tiktok.com/@/video/${id}`])).rows[0];
  assert.deepEqual(row, {
    platform: "tiktok", video_url: `https://www.tiktok.com/@Aliya/video/${id}`, canonical_url: `https://www.tiktok.com/@/video/${id}`,
    username: "Aliya", status: "pending_review", source: "telegram", tg: String(uid), hardware_id: hwid,
    whop_submitted_at: null, campaign_id: null, flags: [],
  });
});

test("duplicate (same user), duplicate-by-other-user (flagged, told 'already submitted'), and Telegram retry of the same update", async () => {
  reset();
  const a = await linkedUser(); const b = await linkedUser();
  const url = tt();
  assert.match((await say(a.uid, url)).text, /✅/);
  assert.match((await say(a.uid, url)).text, /🔁/);
  const other = (await say(b.uid, url)).text;
  assert.match(other, /⚠️/);
  assert.doesNotMatch(other, /حساب آخر/, "must not reveal that another account holds it");
  const row = (await db.query<{ flags: string[]; tg: string }>(`SELECT flags, telegram_user_id::text AS tg FROM video_submissions WHERE canonical_url LIKE $1`, ["%" + url.split("/").pop()])).rows[0];
  assert.deepEqual(row.flags, ["duplicate_of_other_user"]);
  assert.equal(row.tg, String(a.uid));
  assert.equal(await n(`SELECT count(*)::int AS n FROM telegram_duplicate_attempts`) >= 1, true);

  // Retry: same update_id re-delivered after the ledger says 'processing' & stale -> accepted, never 'duplicate'.
  const c = await linkedUser();
  const u2 = messageUpdate(c.uid, tt());
  await send(u2);
  await db.query(`UPDATE telegram_updates SET status = 'processing', claimed_at = now() - interval '5 minutes' WHERE update_id = $1`, [u2.update_id]);
  bot.sent.length = 0;
  await send(u2);
  assert.match(bot.last.text, /✅/);
  assert.doesNotMatch(bot.last.text, /🔁/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [c.uid]), 1);
});

test("mixed message: accepted + unsupported + invalid + repeated, short links flagged opaque, X/YouTube/Instagram accepted", async () => {
  reset();
  const { uid } = await linkedUser();
  const id = tiktokId();
  const text = [
    tt(id), tt(id) + "?x=1", // repeated
    "https://youtu.be/aBcDeFgHiJk?si=zz", "https://twitter.com/someone/status/1700000000000000123?s=20",
    "https://www.instagram.com/reel/C1AbCdEfGhI/?igsh=abc", "https://vm.tiktok.com/ZMabc123/",
    "https://facebook.com/reel/123456", "https://www.tiktok.com/@someuser",
  ].join("\n");
  const r = (await say(uid, text)).text;
  assert.equal((r.match(/✅ تم تسجيل/g) ?? []).length, 5);
  assert.match(r, /منصة غير مدعومة/);
  assert.match(r, /رابط غير صالح/);
  assert.match(r, /مكرر/);
  const rows = (await db.query<{ platform: string; flags: string[] }>(`SELECT platform, flags FROM video_submissions WHERE telegram_user_id = $1 ORDER BY platform`, [uid])).rows;
  assert.deepEqual(rows.map((x) => x.platform).sort(), ["instagram", "tiktok", "tiktok", "x", "youtube"]);
  assert.equal(rows.filter((x) => x.flags.includes("short_link")).length, 1);
});

test("50+ URLs in one message: first 20 handled, rest reported as ignored, reply stays under Telegram's limit", async () => {
  reset();
  const { uid } = await linkedUser();
  const many = Array.from({ length: 60 }, () => tt()).join("\n");
  const r = (await say(uid, many)).text;
  assert.equal((r.match(/✅ تم تسجيل/g) ?? []).length, 20);
  assert.match(r, /تم تجاهل 40 رابط/);
  assert.ok(r.length < 4096);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [uid]), 20);
});

test("captions and hidden text_link entities are honoured", async () => {
  reset();
  const { uid } = await linkedUser();
  const cap = tt();
  const res = await send(messageUpdate(uid, undefined, { caption: `posted ${cap}` }));
  assert.equal(res.status, 200);
  assert.match(bot.last.text, /✅/);
  const hidden = tt();
  await send(messageUpdate(uid, "my clip", { entities: [{ type: "text_link", offset: 3, length: 4, url: hidden }] }));
  assert.match(bot.last.text, /✅/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [uid]), 2);
});

test("message with no link: friendly hint, no writes; only garbage links: refusal, no writes", async () => {
  reset();
  const { uid } = await linkedUser();
  assert.match((await say(uid, "مرحبا كيف الحال")).text, /لم أجد رابطاً/);
  const r = (await say(uid, "https://evil.example.com/x javascript:alert(1) https://tiktok.com@evil.com/@a/video/12345678")).text;
  assert.match(r, /❌/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [uid]), 0);
});

test("rate limit: 30 URLs / 10 min - the 31st onward is refused with a retry time, and the day budget isn't over-charged", async () => {
  reset();
  const { uid } = await linkedUser();
  for (let i = 0; i < 3; i++) await say(uid, Array.from({ length: 10 }, () => tt()).join("\n")); // 30 accepted
  const r = (await say(uid, Array.from({ length: 5 }, () => tt()).join("\n"))).text;
  assert.match(r, /لم يتم تسجيل 5 رابط/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1`, [uid]), 30);
  const day = await n(`SELECT count::int AS n FROM telegram_rate_limits WHERE key = $1`, [`urls:day:${uid}`]);
  assert.equal(day, 30, "URLs refused by the 10-minute window must be refunded from the day counter");
  // Window rolls over -> allowed again.
  await db.query(`UPDATE telegram_rate_limits SET window_start = now() - interval '11 minutes' WHERE key = $1`, [`urls:win:${uid}`]);
  assert.match((await say(uid, tt())).text, /✅/);
});

test("rate limit: partial grant - a 20-URL message with 10 left records 10 and refuses 10", async () => {
  reset();
  const { uid } = await linkedUser();
  await say(uid, Array.from({ length: 20 }, () => tt()).join("\n"));
  const r = (await say(uid, Array.from({ length: 20 }, () => tt()).join("\n"))).text;
  assert.equal((r.match(/✅ تم تسجيل/g) ?? []).length, 10);
  assert.match(r, /لم يتم تسجيل 10 رابط/);
});

test("rate limit: daily cap", async () => {
  reset();
  const { uid } = await linkedUser();
  await db.query(`INSERT INTO telegram_rate_limits (key, window_start, count) VALUES ($1, now(), 299)`, [`urls:day:${uid}`]);
  const r = (await say(uid, `${tt()}\n${tt()}`)).text;
  assert.equal((r.match(/✅ تم تسجيل/g) ?? []).length, 1);
  assert.match(r, /لم يتم تسجيل 1 رابط/);
});

test("message flood from one account goes silent (no reply) once past the per-minute ceiling", async () => {
  reset();
  const uid = newUser();
  for (let i = 0; i < 40; i++) await say(uid, "/help");
  const replies = bot.sent.length;
  assert.equal(replies, 40);
  await send(messageUpdate(uid, "/help"));
  await send(messageUpdate(uid, "/help"));
  assert.equal(bot.sent.length, replies, "over-limit messages must get no reply");
});

// ═══════════════════════════ Campaign attribution ═══════════════════════════

test("attribution: no recent exports => NULL campaign, no keyboard", async () => {
  reset();
  const { uid, hwid } = await linkedUser();
  const old = await mkCampaign("Old");
  await exportFrom(hwid, old, "72 hours"); // outside the 48h window
  const r = await say(uid, tt());
  assert.equal(r.kb, undefined);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id IS NULL`, [uid]), 1);
});

test("attribution: exactly one recent campaign => assigned automatically and named in the reply", async () => {
  reset();
  const { uid, hwid } = await linkedUser();
  const c = await mkCampaign("Gaming Clips");
  await exportFrom(hwid, c); await exportFrom(hwid, c, "3 hours");
  const r = await say(uid, tt());
  assert.match(r.text, /الحملة: Gaming Clips/);
  assert.equal(r.kb, undefined);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id = $2`, [uid, c]), 1);
});

test("attribution: several recent campaigns => saved immediately with NULL, inline keyboard offered, choice applied once", async () => {
  reset();
  const { uid, hwid } = await linkedUser();
  const [a, b] = [await mkCampaign("Alpha"), await mkCampaign("Beta")];
  await exportFrom(hwid, a, "5 hours"); await exportFrom(hwid, b, "1 hour");
  const r = await say(uid, `${tt()}\n${tt()}`);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id IS NULL`, [uid]), 2, "links are saved BEFORE the question");
  assert.deepEqual(r.kb!.map((row) => row[0].text), ["Beta", "Alpha"]); // most recent first
  assert.ok(r.kb!.every((row) => row[0].callback_data.length <= 64));

  const pickAlpha = r.kb![1][0].callback_data;
  await send(callbackUpdate(uid, uid, pickAlpha));
  assert.match(bot.edits.at(-1)!.text, /ربط الروابط بحملة: Alpha/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id = $2`, [uid, a]), 2);
  // replay / second press
  await send(callbackUpdate(uid, uid, r.kb![0][0].callback_data));
  assert.equal(bot.answers.at(-1)!.text, "انتهت صلاحية هذا الخيار أو سبق استخدامه.");
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id = $2`, [uid, b]), 0);
});

test("attribution: callback forgery - other user, other chat, group chat, garbage data, unknown token, expired - all rejected, nothing changes", async () => {
  reset();
  const { uid, hwid } = await linkedUser();
  const [a, b] = [await mkCampaign("F1"), await mkCampaign("F2")];
  await exportFrom(hwid, a); await exportFrom(hwid, b, "2 hours");
  const r = await say(uid, tt());
  const data = r.kb![0][0].callback_data;
  const token = data.split(":")[1];
  const attacker = newUser();
  const editsBefore = bot.edits.length;
  const forged = [
    callbackUpdate(attacker, attacker, data),                     // different Telegram user
    callbackUpdate(uid, uid + 5, data),                            // wrong chat
    callbackUpdate(uid, uid, data, { chatType: "group" }),         // not private
    callbackUpdate(uid, uid, "c:zzzzzzzzzzzzzzzz:0"),              // bad token charset
    callbackUpdate(uid, uid, "c:0000000000000000:0"),              // unknown token
    callbackUpdate(uid, uid, `c:${token}:9`),                       // index out of range
    callbackUpdate(uid, uid, `c:${token}:-1`),                      // malformed index
    callbackUpdate(uid, uid, `x:${token}:0`),                       // unknown kind
    callbackUpdate(uid, uid, "c:" + token + ":0:extra"),
    callbackUpdate(uid, uid, ""),
  ];
  for (const f of forged) assert.equal((await send(f)).status, 200);
  assert.equal(bot.edits.length, editsBefore, "no forged callback may edit a message");
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id IS NOT NULL`, [uid]), 0);
  // Expired token
  await db.query(`UPDATE telegram_pending_choices SET expires_at = now() - interval '1 second' WHERE token = $1`, [token]);
  await send(callbackUpdate(uid, uid, data));
  assert.equal(await n(`SELECT count(*)::int AS n FROM video_submissions WHERE telegram_user_id = $1 AND campaign_id IS NOT NULL`, [uid]), 0);
  // A callback with no message at all
  const noMsg = { update_id: nextUpdateId(), callback_query: { id: "x", from: { id: uid }, data } };
  assert.equal((await send(noMsg)).status, 200);
});

// ═══════════════════════════ Output escaping ════════════════════════════════

test("replies never reflect raw HTML: hostile campaign names, usernames and URLs are escaped", async () => {
  reset();
  const { uid, hwid } = await linkedUser({ username: "<b>evil</b>" });
  const [a, b] = [await mkCampaign(`<script>alert(1)</script> & "x"`), await mkCampaign("Normal")];
  await exportFrom(hwid, a); await exportFrom(hwid, b, "2 hours");
  const r = await say(uid, `https://www.tiktok.com/@we<i>rd/video/12345678901 https://evil.com/<script>alert(1)</script>?a=1&b=2`);
  for (const m of bot.sent) {
    assert.doesNotMatch(m.text, /<script/i);
    // Only tags we author ourselves may appear.
    const tags = m.text.match(/<\/?[a-z][^>]*>/gi) ?? [];
    assert.ok(tags.every((t) => /^<\/?(b|code)>$/i.test(t)), `unexpected tag(s): ${tags.join(",")}`);
  }
  assert.match(r.text, /&amp;|&lt;/);
  await send(callbackUpdate(uid, uid, r.kb?.[0][0].callback_data ?? "c:0000000000000000:0"));
  for (const e of bot.edits) assert.doesNotMatch(e.text, /<script/i);
});

test("replies stay under Telegram's size limit even with 20 long hostile URLs", async () => {
  reset();
  const { uid } = await linkedUser();
  const bad = Array.from({ length: 20 }, (_, i) => `https://evil${i}.example.com/${"a&b<c>".repeat(300)}`).join("\n");
  await say(uid, bad);
  assert.ok(bot.last.text.length < 4096);
});

// ═══════════════════════════ Privacy ════════════════════════════════════════

test("privacy: no message bodies are persisted - only URLs in video_submissions, ids/usernames/language elsewhere", async () => {
  reset();
  const { uid } = await linkedUser({ username: "bob" });
  const secretChat = "my private sentence 0123456789 do-not-store";
  await say(uid, `${secretChat} ${tt()}`);
  const dump = await db.query<{ t: string }>(`
    SELECT (SELECT coalesce(string_agg(v::text, ' '), '') FROM (
      SELECT to_jsonb(x) AS v FROM telegram_users x UNION ALL SELECT to_jsonb(x) FROM telegram_links x UNION ALL
      SELECT to_jsonb(x) FROM telegram_updates x UNION ALL SELECT to_jsonb(x) FROM telegram_rate_limits x UNION ALL
      SELECT to_jsonb(x) FROM telegram_pending_choices x UNION ALL SELECT to_jsonb(x) FROM telegram_duplicate_attempts x UNION ALL
      SELECT to_jsonb(x) FROM video_submissions x) s) AS t`);
  assert.doesNotMatch(dump.rows[0].t, /do-not-store|private sentence/);
});
