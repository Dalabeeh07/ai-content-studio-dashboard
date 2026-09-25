import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLinkCode, generateLinkCode, hashLinkCode, newChoiceToken, normalizeLinkCode } from "../../lib/telegram/codes";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH } from "../../lib/telegram/config";
import { readBodyCapped, verifyWebhookSecret } from "../../lib/telegram/security";
import { parseUpdate } from "../../lib/telegram/types";
import { detectLang, esc, plainLabel, shortUrl } from "../../lib/telegram/messages";
import { createBotApi } from "../../lib/telegram/api";

test("link codes: right length/alphabet, no ambiguous characters, and well spread", () => {
  assert.equal(new Set(LINK_CODE_ALPHABET).size, LINK_CODE_ALPHABET.length);
  for (const bad of ["0", "O", "1", "I", "L"]) assert.ok(!LINK_CODE_ALPHABET.includes(bad), bad);
  const seen = new Set<string>();
  const freq = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    const c = generateLinkCode();
    assert.equal(c.length, LINK_CODE_LENGTH);
    assert.ok([...c].every((ch) => LINK_CODE_ALPHABET.includes(ch)));
    seen.add(c);
    for (const ch of c) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  assert.equal(seen.size, 4000, "collision in 4000 draws from a ~40-bit space");
  // No character wildly over/under-represented (crude uniformity check, expected ~1032 each).
  for (const [ch, k] of freq) assert.ok(k > 800 && k < 1300, `${ch} appeared ${k} times`);
});

test("normalizeLinkCode: case, hyphen and spacing are forgiven; everything else is refused", () => {
  const c = generateLinkCode();
  for (const v of [c, c.toLowerCase(), formatLinkCode(c), formatLinkCode(c).toLowerCase(), ` ${c.slice(0, 3)} ${c.slice(3)} `, c.split("").join("-")]) {
    assert.equal(normalizeLinkCode(v), c);
  }
  for (const v of ["", "ABC", c + "X", c.slice(0, 7), "0000OOOO", "IIIIIIII", "ABCD-EFG!", "ABCD EFGH IJKL", "a".repeat(100), "٢٣٤٥٦٧٨٩", "ＡＢＣＤＥＦＧＨ"]) {
    assert.equal(normalizeLinkCode(v), null, JSON.stringify(v));
  }
  assert.equal(normalizeLinkCode(undefined as unknown as string), null);
});

test("hashLinkCode: deterministic, keyed by the secret, never equals the code, secret required", () => {
  const h1 = hashLinkCode("K7QMR2XP", "secret-A");
  assert.equal(h1, hashLinkCode("K7QMR2XP", "secret-A"));
  assert.notEqual(h1, hashLinkCode("K7QMR2XP", "secret-B"));
  assert.notEqual(h1, hashLinkCode("K7QMR2XQ", "secret-A"));
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.ok(!h1.includes("K7QMR2XP"));
  assert.throws(() => hashLinkCode("K7QMR2XP", ""));
});

test("choice tokens: 64-bit hex, unique, fit callback_data", () => {
  const s = new Set<string>();
  for (let i = 0; i < 2000; i++) { const t = newChoiceToken(); assert.match(t, /^[0-9a-f]{16}$/); s.add(t); }
  assert.equal(s.size, 2000);
  assert.ok(`c:${newChoiceToken()}:4`.length <= 64);
});

test("verifyWebhookSecret: exact match only; empty/absent never authenticates", () => {
  const S = "s3cret_-Value123";
  assert.equal(verifyWebhookSecret(S, S), true);
  for (const h of [null, undefined, "", " ", S + " ", " " + S, S.toLowerCase(), S.slice(1), S + S]) assert.equal(verifyWebhookSecret(h as string, S), false, JSON.stringify(h));
  assert.equal(verifyWebhookSecret("", ""), false);
  assert.equal(verifyWebhookSecret("anything", ""), false);
  assert.equal(verifyWebhookSecret(null, ""), false);
});

test("readBodyCapped: reads under the cap, refuses over it, honours a lying content-length", async () => {
  const mk = (body: string, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body, headers });
  assert.deepEqual(await readBodyCapped(mk("hello"), 100), { ok: true, text: "hello" });
  assert.deepEqual(await readBodyCapped(mk(""), 100), { ok: true, text: "" });
  assert.deepEqual(await readBodyCapped(mk("x".repeat(101)), 100), { ok: false, reason: "too_large" });
  assert.deepEqual(await readBodyCapped(mk("x".repeat(100)), 100), { ok: true, text: "x".repeat(100) });
  assert.deepEqual(await readBodyCapped(mk("x".repeat(500), { "content-length": "5" }), 100), { ok: false, reason: "too_large" });
  const multi = await readBodyCapped(mk("é".repeat(60)), 100); // 120 bytes of UTF-8 in 60 chars
  assert.deepEqual(multi, { ok: false, reason: "too_large" });
});

test("parseUpdate: accepts private text/caption messages and callbacks; rejects the rest", () => {
  const ok = parseUpdate({ update_id: 1, message: { message_id: 2, from: { id: 5, username: "u", language_code: "ar" }, chat: { id: 5, type: "private" }, text: "hi" } });
  assert.equal(ok?.message?.text, "hi");
  assert.equal(ok?.message?.from?.language_code, "ar");
  assert.ok(parseUpdate({ update_id: 1, message: { message_id: 2, from: { id: 5 }, chat: { id: 5, type: "private" }, caption: "c" } }));
  assert.ok(parseUpdate({ update_id: 3, callback_query: { id: "a", from: { id: 5 }, data: "c:0123456789abcdef:0", message: { message_id: 1, chat: { id: 5, type: "private" } } } }));
  // Untrusted fields are clipped/typed, never trusted.
  const long = parseUpdate({ update_id: 1, message: { message_id: 2, from: { id: 5, username: "x".repeat(500) }, chat: { id: 5, type: "private" }, text: "t", entities: "not-an-array" } });
  assert.equal(long?.message?.from?.username?.length, 64);
  assert.equal(long?.message?.entities, undefined);
  for (const bad of [
    null, undefined, 5, "x", [], {}, { update_id: "1" }, { update_id: -1 }, { update_id: 1.2 }, { update_id: Number.MAX_SAFE_INTEGER + 10 },
    { update_id: 1 }, { update_id: 1, message: null }, { update_id: 1, edited_message: { message_id: 1 } },
    { update_id: 1, message: { message_id: 2, from: { id: 5 }, chat: { id: 5, type: "group" }, text: "x" } },
    { update_id: 1, message: { message_id: 2, from: { id: 5, is_bot: true }, chat: { id: 5, type: "private" }, text: "x" } },
    { update_id: 1, message: { message_id: 2, from: { id: 5 }, chat: { id: 6, type: "private" }, text: "x" } },
    { update_id: 1, message: { message_id: 2, from: { id: 0 }, chat: { id: 0, type: "private" }, text: "x" } },
    { update_id: 1, message: { message_id: 2, from: { id: "5" }, chat: { id: 5, type: "private" }, text: "x" } },
    { update_id: 1, message: { message_id: "2", from: { id: 5 }, chat: { id: 5, type: "private" }, text: "x" } },
    { update_id: 1, callback_query: { id: "", from: { id: 5 } } },
    { update_id: 1, callback_query: { id: "a", from: { id: 5, is_bot: true } } },
    { update_id: 1, callback_query: null },
  ]) assert.equal(parseUpdate(bad as unknown), null, JSON.stringify(bad));
});

test("messages: esc / plainLabel / shortUrl / detectLang", () => {
  assert.equal(esc(`<a href="x">&</a>`), `&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
  assert.equal(esc(null), ""); assert.equal(esc(42), "42");
  assert.equal(plainLabel("  a\nb\u0000c  "), "a b c");
  assert.equal(plainLabel("x".repeat(100)).length, 48);
  const su = shortUrl(`https://www.tiktok.com/@u/video/1?a=1&b=<x>`);
  assert.ok(su.includes("&amp;") && su.includes("&lt;x&gt;") && !su.includes("https://"));
  assert.ok(shortUrl("https://" + "a".repeat(200)).length < 80);
  assert.equal(detectLang("en"), "en"); assert.equal(detectLang("en-US"), "en"); assert.equal(detectLang("EN_gb"), "en");
  for (const l of ["ar", "ar-EG", "fr", "de", "eng", "english", "", undefined]) assert.equal(detectLang(l), "ar", String(l));
});

test("bot api: never throws, never leaks the token, drops replies when unconfigured or timing out", async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const TOKEN = "123456:SECRET-TOKEN-VALUE";
    const boom = createBotApi({ token: TOKEN, fetchImpl: (async () => { throw new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`); }) as unknown as typeof fetch });
    assert.equal(await boom.sendMessage(1, "hi"), false);
    const http500 = createBotApi({ token: TOKEN, fetchImpl: (async () => new Response(JSON.stringify({ description: "Bad Request: chat not found" }), { status: 400 })) as unknown as typeof fetch });
    assert.equal(await http500.sendMessage(1, "hi"), false);
    assert.equal(await createBotApi({ token: "" }).sendMessage(1, "hi"), false);
    let body: Record<string, unknown> = {};
    let url = "";
    const good = createBotApi({ token: TOKEN, baseUrl: "http://127.0.0.1:1/", fetchImpl: (async (u: string, init: RequestInit) => { url = u; body = JSON.parse(String(init.body)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch });
    assert.equal(await good.sendMessage(7, "x".repeat(9000), [[{ text: "a", callback_data: "b" }]]), true);
    assert.equal(url, `http://127.0.0.1:1/bot${TOKEN}/sendMessage`);
    assert.equal(body.parse_mode, "HTML");
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.equal((body.text as string).length, 4000);
    assert.ok(body.reply_markup);
    assert.equal(logged.some((l) => l.includes("SECRET-TOKEN-VALUE")), false, `token leaked into logs: ${logged.join(" | ")}`);
  } finally {
    console.error = orig;
  }
});
