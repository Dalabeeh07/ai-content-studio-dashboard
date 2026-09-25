// REAL `next start` server + REAL Supabase + a LOCAL fake Telegram (the real
// bot and its token are never involved: the token below is a fake, and the
// server's TELEGRAM_API_BASE points at 127.0.0.1). Fake updates are POSTed
// to the production webhook route exactly as Telegram would send them.
//
// Real concurrency is the point of this file: the PGlite suites prove the SQL
// logic on one connection; here N requests hit the real database in parallel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateLinkCode, formatLinkCode, hashLinkCode } from "../../lib/telegram/codes";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fakeTelegram";
import {
  cleanup, fmt, mkCampaign, mkExport, mkUser, nextTgId, nextUpdateId, post, postOversized, startApp, stats, svc, tableCounts,
  type App,
} from "./helpers";

const SECRET = `TEST_TG_${crypto.randomBytes(20).toString("hex")}`;
const FAKE_TOKEN = `987654321:TEST_TG_FAKE_TOKEN_${crypto.randomBytes(12).toString("hex")}`;
const PORT = 3100;
let app: App;
let fake: FakeTelegram;
let baseline: Record<string, number>;
const latencies: number[] = [];
const issuedCodes: string[] = [];

const hook = () => `${app.base}/api/telegram/webhook`;
const H = (secret: string | null = SECRET): Record<string, string> => (secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret });

before(async () => {
  await cleanup();
  baseline = await tableCounts();
  fake = await startFakeTelegram();
  app = await startApp(PORT, { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_API_BASE: fake.url });
});
after(async () => {
  console.log(`\n  webhook latency (real DB, real network to Supabase): ${fmt(stats(latencies))}`);
  await app?.stop();
  await fake?.close();
  await cleanup();
  const now = await tableCounts();
  assert.deepEqual(now, baseline, "every table must be back to its pre-test row count");
});

// ── builders ────────────────────────────────────────────────────────────────
const msg = (uid: number, text: string, o: { updateId?: number; lang?: string; chatType?: string; username?: string } = {}) => ({
  update_id: o.updateId ?? nextUpdateId(),
  message: {
    message_id: 1, from: { id: uid, is_bot: false, username: o.username, language_code: o.lang }, chat: { id: uid, type: o.chatType ?? "private" }, text,
  },
});
const cb = (fromId: number, chatId: number, data: string, chatType = "private") => ({
  update_id: nextUpdateId(),
  callback_query: { id: `cbq_${crypto.randomBytes(4).toString("hex")}`, from: { id: fromId, is_bot: false }, data, message: { message_id: 7, chat: { id: chatId, type: chatType } } },
});
async function send(update: unknown, secret: string | null = SECRET) {
  const r = await post(hook(), update, H(secret));
  if (r.status === 200) latencies.push(r.ms);
  return r;
}
const repliesTo = (uid: number) => fake.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === uid).map((c) => String(c.body.text));
const lastReply = (uid: number) => repliesTo(uid).at(-1) ?? "";
async function issueCode(hwid: string, userId: string, ttl = 3600) {
  const code = generateLinkCode();
  issuedCodes.push(code);
  const { error } = await svc().rpc("tg_create_link_code", { p_hwid: hwid, p_user_id: userId, p_code_hash: hashLinkCode(code, SECRET), p_ttl_seconds: ttl });
  assert.equal(error, null, error?.message);
  return code;
}
async function linkedAccount() {
  const uid = nextTgId();
  const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  await send(msg(uid, `/link ${formatLinkCode(code)}`));
  assert.match(lastReply(uid), /تم ربط/);
  return { uid, ...u };
}
const count = async (table: string, filter?: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = svc().from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  assert.equal(error, null, error?.message);
  return c ?? 0;
};
let ttSeq = Date.now() % 1_000_000_000;
const tt = () => `https://www.tiktok.com/@creator/video/73${String(++ttSeq).padStart(17, "0")}`;

// ═══════════════ authentication & request hardening ═════════════════════════

test("missing / wrong secret => 401, and NO row in any table changes", async () => {
  const before = await tableCounts();
  const u = msg(nextTgId(), "/start");
  for (const secret of [null, "", "wrong", SECRET.slice(0, -1), SECRET + "x", SECRET.toLowerCase(), " " + SECRET]) {
    const r = await send(u, secret);
    assert.equal(r.status, 401, `secret=${JSON.stringify(secret)}: got ${r.status}`);
  }
  assert.deepEqual(await tableCounts(), before);
  assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 0, "no reply may be sent to an unauthenticated caller");
});

test("webhook is reachable WITHOUT an admin session (public by exact path), other paths under it are not", async () => {
  const r = await post(hook(), {}, H());
  assert.equal(r.status, 200); // not a 307 to /login
  const sibling = await post(`${app.base}/api/telegram/webhook/extra`, {}, H());
  assert.ok([307, 308, 404].includes(sibling.status), `sibling path returned ${sibling.status}`);
  assert.notEqual(sibling.status, 200);
  const get = await fetch(hook(), { redirect: "manual", headers: H() });
  assert.equal(get.status, 405, "only POST is served");
});

test("oversized body => 413 (valid secret), nothing written; body limit holds even with a lying Content-Length", async () => {
  const before = await tableCounts();
  const big = JSON.stringify({ update_id: nextUpdateId(), message: { text: "x".repeat(300_000) } });
  // A correct server answers 413 and/or drops the connection mid-upload (undici reports the latter as a refused fetch).
  const a = await postOversized(hook(), big, H());
  assert.ok(a === 413 || a === "refused", `oversized body: ${a}`);
  const b = await postOversized(hook(), big, { ...H(), "Content-Length": "20" });
  assert.ok(b === 413 || b === "refused" || b === 400 || b === 200, `lying content-length: ${b}`);
  assert.deepEqual(await tableCounts(), before);
});

test("malformed JSON / wrong shapes / non-private chats / edited / channel / bots => 200 and zero writes", async () => {
  const before = await tableCounts();
  const uid = nextTgId();
  const bodies: unknown[] = [
    "{not json", "", "null", "[]", '{"update_id":"1"}', '{"update_id":-1}', "{}",
    msg(uid, "/start", { chatType: "group" }), msg(uid, "/start", { chatType: "supergroup" }), msg(uid, "/start", { chatType: "channel" }),
    { update_id: nextUpdateId(), edited_message: msg(uid, "/start").message },
    { update_id: nextUpdateId(), channel_post: msg(uid, "/start").message },
    { update_id: nextUpdateId(), message: { ...msg(uid, "/start").message, from: { id: uid, is_bot: true } } },
    { update_id: nextUpdateId(), message: { message_id: 1, from: { id: uid }, chat: { id: uid, type: "private" } } },
  ];
  for (const b of bodies) assert.equal((await post(hook(), typeof b === "string" ? b : JSON.stringify(b), H())).status, 200, String(JSON.stringify(b)).slice(0, 80));
  assert.deepEqual(await tableCounts(), before);
  assert.equal(repliesTo(uid).length, 0);
});

test("a 10KB Arabic message with a link in the middle is handled (no crash, link recorded)", async () => {
  const { uid } = await linkedAccount();
  const filler = "كلام عربي طويل جداً 🎬 ".repeat(300);
  const r = await send(msg(uid, `${filler} ${tt()} ${filler}`));
  assert.equal(r.status, 200);
  assert.match(lastReply(uid), /✅/);
});

// ═══════════════ idempotency & concurrency (real DB, real parallelism) ══════

test("replayed update_id is processed exactly once", async () => {
  const uid = nextTgId();
  const u = msg(uid, "/help");
  for (let i = 0; i < 4; i++) assert.equal((await send(u)).status, 200);
  assert.equal(repliesTo(uid).length, 1);
  assert.equal(await count("telegram_updates", (q) => q.eq("update_id", u.update_id)), 1);
});

test("12 CONCURRENT deliveries of the same update => one reply, one ledger row", async () => {
  const uid = nextTgId();
  const u = msg(uid, "/help");
  const rs = await Promise.all(Array.from({ length: 12 }, () => send(u)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(repliesTo(uid).length, 1);
  assert.equal(await count("telegram_updates", (q) => q.eq("update_id", u.update_id)), 1);
});

test("CONCURRENT redemption of ONE link code by 10 accounts: exactly one wins", async () => {
  const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  const accounts = Array.from({ length: 10 }, () => nextTgId());
  await Promise.all(accounts.map((a) => send(msg(a, `/link ${code}`))));
  assert.equal(await count("telegram_links", (q) => q.eq("hwid", u.hwid).is("revoked_at", null)), 1);
  const winners = accounts.filter((a) => /تم ربط/.test(lastReply(a)));
  assert.equal(winners.length, 1, `winners: ${winners.length}`);
  const losers = accounts.filter((a) => !winners.includes(a));
  assert.ok(losers.every((a) => /غير صحيح/.test(lastReply(a))), "every loser gets the generic refusal");
  const { data } = await svc().from("telegram_link_codes").select("used_by_telegram_user_id, used_at").eq("hwid", u.hwid).single();
  assert.equal(Number(data?.used_by_telegram_user_id), winners[0]);
});

test("the SAME link sent concurrently by two linked users => ONE row, first wins, other told 'already submitted', original flagged", async () => {
  const a = await linkedAccount(); const b = await linkedAccount();
  const url = tt();
  await Promise.all([send(msg(a.uid, url)), send(msg(b.uid, url))]);
  const canonical = url.replace(/@[^/]+/, "@");
  const { data } = await svc().from("video_submissions").select("id, telegram_user_id, flags").eq("canonical_url", canonical);
  assert.equal(data?.length, 1, "canonical_url must be globally unique under concurrency");
  const holder = Number(data?.[0].telegram_user_id);
  const other = holder === a.uid ? b.uid : a.uid;
  assert.match(lastReply(holder), /✅/);
  assert.match(lastReply(other), /⚠️/);
  assert.deepEqual(data?.[0].flags, ["duplicate_of_other_user"]);
  assert.equal(await count("telegram_duplicate_attempts", (q) => q.eq("submission_id", data?.[0].id)), 1);
});

test("rate limit holds under real concurrency: 10 parallel messages x 10 URLs => exactly 30 recorded", async () => {
  const { uid } = await linkedAccount();
  await Promise.all(Array.from({ length: 10 }, () => send(msg(uid, Array.from({ length: 10 }, tt).join("\n")))));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", uid)), 30);
  const replies = repliesTo(uid);
  assert.ok(replies.some((r) => /لم يتم تسجيل/.test(r)), "refused URLs are reported");
  const { data } = await svc().from("telegram_rate_limits").select("count").eq("key", `urls:day:${uid}`).single();
  assert.equal(data?.count, 30, "day counter must equal what was actually recorded (refusals refunded)");
});

// ═══════════════ linking ════════════════════════════════════════════════════

test("link: happy path, reuse, unknown, malformed, expired, and generic refusals", async () => {
  const u = await mkUser();
  const code = await issueCode(u.hwid, u.id);
  const a = nextTgId(); const b = nextTgId();
  await send(msg(a, `/link ${code}`, { username: "alice" }));
  assert.match(lastReply(a), /تم ربط/);
  const { data: link } = await svc().from("telegram_links").select("hwid, user_id, revoked_at").eq("telegram_user_id", a).single();
  assert.deepEqual([link?.hwid, link?.user_id, link?.revoked_at], [u.hwid, u.id, null]);
  const { data: tu } = await svc().from("telegram_users").select("username, language").eq("telegram_user_id", a).single();
  assert.deepEqual(tu, { username: "alice", language: "ar" });

  await send(msg(b, `/link ${code}`));                               // reuse
  const reuse = lastReply(b);
  await send(msg(b, `/link ${generateLinkCode()}`));                 // unknown
  const unknown = lastReply(b);
  await send(msg(b, "/link 12"));                                    // malformed
  assert.match(reuse, /غير صحيح/);
  assert.equal(reuse, unknown, "used and unknown codes must be indistinguishable");

  const u2 = await mkUser();
  const c2 = await issueCode(u2.hwid, u2.id, 3600);
  await svc().from("telegram_link_codes").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("hwid", u2.hwid);
  await send(msg(b, `/link ${c2}`));
  assert.equal(lastReply(b), reuse, "expired must be indistinguishable too");
  assert.equal(await count("telegram_links", (q) => q.eq("hwid", u2.hwid)), 0);
});

test("link brute force: the 6th attempt is throttled even when the code is CORRECT", async () => {
  const attacker = nextTgId();
  for (let i = 0; i < 5; i++) await send(msg(attacker, `/link ${generateLinkCode()}`));
  const u = await mkUser();
  const good = await issueCode(u.hwid, u.id);
  await send(msg(attacker, `/link ${good}`));
  assert.match(lastReply(attacker), /محاولات كثيرة/);
  assert.equal(await count("telegram_links", (q) => q.eq("hwid", u.hwid)), 0);
  const other = nextTgId();
  await send(msg(other, `/link ${good}`));
  assert.match(lastReply(other), /تم ربط/);
});

test("re-link (new code for a linked hwid) moves the link; old account loses access; history kept", async () => {
  const a = await linkedAccount();
  const b = nextTgId();
  const code = await issueCode(a.hwid, a.id);
  await send(msg(b, `/link ${code}`));
  assert.match(lastReply(b), /تم ربط/);
  await send(msg(a.uid, tt()));
  assert.match(lastReply(a.uid), /غير مربوط/);
  const { data } = await svc().from("telegram_links").select("telegram_user_id, revoked_by").eq("hwid", a.hwid);
  assert.equal(data?.length, 2);
  assert.deepEqual(data?.filter((r) => r.revoked_by === null).map((r) => Number(r.telegram_user_id)), [b]);
});

test("admin revoke (tg_revoke_link_admin) cuts access immediately", async () => {
  const a = await linkedAccount();
  const { data, error } = await svc().rpc("tg_revoke_link_admin", { p_hwid: a.hwid });
  assert.equal(error, null);
  assert.equal((data as { links_revoked: number }).links_revoked, 1);
  await send(msg(a.uid, tt()));
  assert.match(lastReply(a.uid), /غير مربوط/);
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", a.uid)), 0);
});

// ═══════════════ submissions ════════════════════════════════════════════════

test("unlinked user: told to link, nothing written to video_submissions", async () => {
  const uid = nextTgId();
  const before = await count("video_submissions");
  await send(msg(uid, tt()));
  assert.match(lastReply(uid), /غير مربوط/);
  assert.equal(await count("video_submissions"), before);
});

test("end to end: link, send messy real-world text, row lands with the right fields; second send is 'already submitted'", async () => {
  const { uid, hwid, id: userId } = await linkedAccount();
  const url = tt();
  await send(msg(uid, `شوف الفيديو 🔥 ${url}?is_from_webapp=1&sender_device=pc&utm_source=copy`, { username: "aliya" }));
  assert.match(lastReply(uid), /✅ تم تسجيل TikTok/);
  assert.match(lastReply(uid), /عدد روابطك اليوم: 1/);
  const canonical = url.replace(/@[^/]+/, "@");
  const { data } = await svc().from("video_submissions").select("*").eq("canonical_url", canonical).single();
  assert.equal(data?.source, "telegram"); assert.equal(Number(data?.telegram_user_id), uid);
  assert.equal(data?.hardware_id, hwid); assert.equal(data?.user_id, userId);
  assert.equal(data?.video_url, url); assert.equal(data?.username, "creator");
  assert.equal(data?.status, "pending_review"); assert.equal(data?.whop_submitted_at, null);
  assert.ok(!/[?#]/.test(data?.video_url), "tracking params must be stripped");
  await send(msg(uid, url));
  assert.match(lastReply(uid), /🔁/);
  assert.equal(await count("video_submissions", (q) => q.eq("canonical_url", canonical)), 1);
  await send(msg(uid, "/count"));
  assert.match(lastReply(uid), /<b>1<\/b>/);
  await send(msg(uid, "/mylinks"));
  assert.match(lastReply(uid), /TikTok/);
});

test("nasty URLs in a real message: userinfo/lookalike/javascript: are refused, the one real link is kept", async () => {
  const { uid } = await linkedAccount();
  const good = tt();
  await send(msg(uid, [
    "https://tiktok.com@evil.com/@u/video/12345678901", "https://tiktok.com.evil.co/@u/video/12345678901",
    "https://xn--tktok-9ta.com/@u/video/12345678901", "javascript:alert(1)", "https://127.0.0.1/@u/video/12345678901", good,
  ].join("\n")));
  const r = lastReply(uid);
  assert.equal((r.match(/✅ تم تسجيل/g) ?? []).length, 1);
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", uid)), 1);
});

test("50+ URLs: 20 recorded, the rest reported as ignored", async () => {
  const { uid } = await linkedAccount();
  await send(msg(uid, Array.from({ length: 55 }, tt).join(" ")));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", uid)), 20);
  assert.match(lastReply(uid), /تم تجاهل 35 رابط/);
});

// ═══════════════ campaign attribution (real campaign_exports) ═══════════════

test("attribution: none => NULL; one => auto-assigned; several => saved first, keyboard, choice applied once; forged presses rejected", async () => {
  const none = await linkedAccount();
  await send(msg(none.uid, tt()));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", none.uid).is("campaign_id", null)), 1);

  const one = await linkedAccount();
  const c1 = await mkCampaign("One");
  await mkExport(one.hwid, c1.id);
  await send(msg(one.uid, tt()));
  assert.match(lastReply(one.uid), new RegExp(`الحملة: ${c1.name}`));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", one.uid).eq("campaign_id", c1.id)), 1);

  const many = await linkedAccount();
  const [a, b] = [await mkCampaign("Alpha"), await mkCampaign("Beta")];
  await mkExport(many.hwid, a.id, 5); await mkExport(many.hwid, b.id, 1);
  await send(msg(many.uid, `${tt()}\n${tt()}`));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", many.uid).is("campaign_id", null)), 2);
  const sent = fake.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === many.uid).at(-1)!;
  const kb = (sent.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.deepEqual(kb.map((r) => r[0].text), [b.name, a.name]);
  const pickAlpha = kb[1][0].callback_data;
  const attacker = nextTgId();

  for (const forged of [cb(attacker, attacker, pickAlpha), cb(many.uid, many.uid + 1, pickAlpha), cb(many.uid, many.uid, pickAlpha, "group"), cb(many.uid, many.uid, "c:0000000000000000:0"), cb(many.uid, many.uid, pickAlpha.replace(/:\d$/, ":9"))]) {
    assert.equal((await send(forged)).status, 200);
  }
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", many.uid).not("campaign_id", "is", null)), 0, "forged callbacks must change nothing");
  assert.equal(fake.calls.filter((c) => c.method === "editMessageText" && c.body.chat_id === many.uid).length, 0);

  await send(cb(many.uid, many.uid, pickAlpha));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", many.uid).eq("campaign_id", a.id)), 2);
  await send(cb(many.uid, many.uid, kb[0][0].callback_data)); // replay: token already used
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", many.uid).eq("campaign_id", b.id)), 0);

  // Expired picker
  await send(msg(many.uid, tt()));
  const kb2 = ((fake.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === many.uid).at(-1)!.body.reply_markup) as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  const tok = kb2[0][0].callback_data.split(":")[1];
  await svc().from("telegram_pending_choices").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("token", tok);
  await send(cb(many.uid, many.uid, kb2[0][0].callback_data));
  assert.equal(await count("video_submissions", (q) => q.eq("telegram_user_id", many.uid).is("campaign_id", null)), 1, "expired token must not assign");
});

// ═══════════════ commands & privacy ═════════════════════════════════════════

test("/lang persists per user, /unlink needs the confirmation button, only ONCE and only for the owner", async () => {
  const { uid } = await linkedAccount();
  await send(msg(uid, "/lang en"));
  assert.match(lastReply(uid), /English/);
  await send(msg(uid, "/count"));
  assert.match(lastReply(uid), /UTC/);
  const { data } = await svc().from("telegram_users").select("language").eq("telegram_user_id", uid).single();
  assert.equal(data?.language, "en");

  await send(msg(uid, "/unlink"));
  const kb = (fake.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === uid).at(-1)!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  const yes = kb[0][0].callback_data;
  await send(cb(nextTgId(), uid, yes));                     // someone else presses it
  assert.equal(await count("telegram_links", (q) => q.eq("telegram_user_id", uid).is("revoked_at", null)), 1);
  await send(cb(uid, uid, yes));
  assert.equal(await count("telegram_links", (q) => q.eq("telegram_user_id", uid).is("revoked_at", null)), 0);
  await send(cb(uid, uid, yes));                            // replay is dead
});

test("privacy: nothing but URLs/ids/usernames/language is stored; a private sentence never reaches the DB", async () => {
  const { uid } = await linkedAccount();
  const secretSentence = `TEST_TG_PRIVATE_SENTENCE_${crypto.randomBytes(6).toString("hex")}`;
  await send(msg(uid, `${secretSentence} ${tt()}`));
  for (const table of ["telegram_users", "telegram_links", "telegram_updates", "telegram_rate_limits", "telegram_pending_choices", "telegram_duplicate_attempts", "video_submissions"]) {
    const { data } = await svc().from(table).select("*").limit(5000);
    assert.ok(!JSON.stringify(data).includes(secretSentence), `${table} contains the message body`);
  }
});

// ═══════════════ secrets in logs; missing-secret server ═════════════════════

test("server not configured (no TELEGRAM_WEBHOOK_SECRET) => 503 and no writes", async () => {
  const bare = await startApp(PORT + 2, { TELEGRAM_WEBHOOK_SECRET: "", TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_API_BASE: fake.url });
  try {
    const before = await tableCounts();
    assert.equal((await post(`${bare.base}/api/telegram/webhook`, msg(nextTgId(), "/start"), H(""))).status, 503);
    assert.equal((await post(`${bare.base}/api/telegram/webhook`, msg(nextTgId(), "/start"), {})).status, 503);
    assert.deepEqual(await tableCounts(), before);
  } finally { await bare.stop(); }
});

test("no secret, token, or link code ever appears in the server's logs; the fake token was the only one used", async () => {
  const logs = app.logs();
  assert.ok(!logs.includes(SECRET), "webhook secret leaked into logs");
  assert.ok(!logs.includes(FAKE_TOKEN) && !logs.includes(FAKE_TOKEN.split(":")[1]), "bot token leaked into logs");
  for (const code of issuedCodes) assert.ok(!logs.includes(code), "a link code leaked into logs");
  const tokens = new Set(fake.calls.map((c) => c.tokenSeen));
  assert.deepEqual([...tokens], [FAKE_TOKEN], "Bot API calls must use the configured token, and only that");
  assert.ok(fake.calls.every((c) => c.body.parse_mode === undefined || c.body.parse_mode === "HTML"));
});
