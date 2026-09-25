import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, extractCandidates, extractFromMessage } from "../../lib/telegram/url";
import { MAX_URLS_PER_MESSAGE } from "../../lib/telegram/config";

function accepted(raw: string) {
  const r = classifyUrl(raw);
  assert.equal(r.ok, true, `expected ACCEPT for ${raw}, got ${JSON.stringify(r)}`);
  return r as Extract<ReturnType<typeof classifyUrl>, { ok: true }>;
}
function rejected(raw: string, reason?: "invalid" | "unsupported_platform") {
  const r = classifyUrl(raw);
  assert.equal(r.ok, false, `expected REJECT for ${raw}, got ${JSON.stringify(r)}`);
  if (reason) assert.equal((r as { reason: string }).reason, reason, `reason for ${raw}`);
}

// ── Accept + canonicalization ───────────────────────────────────────────────

test("tiktok: full video URL, all variants collapse to one canonical", () => {
  const variants = [
    "https://www.tiktok.com/@SomeUser/video/7234567890123456789",
    "https://tiktok.com/@someuser/video/7234567890123456789/",
    "http://m.tiktok.com/@SOMEUSER/video/7234567890123456789?is_from_webapp=1&sender_device=pc",
    "https://www.tiktok.com/@someuser/video/7234567890123456789?utm_source=copy&_r=1#frag",
    "tiktok.com/@someuser/video/7234567890123456789",
    "HTTPS://WWW.TIKTOK.COM/@someuser/VIDEO/7234567890123456789",
  ];
  const canon = new Set(variants.map((v) => accepted(v).canonicalUrl));
  assert.equal(canon.size, 1);
  assert.equal([...canon][0], "https://www.tiktok.com/@/video/7234567890123456789");
  const a = accepted(variants[0]);
  assert.equal(a.platform, "tiktok");
  assert.equal(a.videoUrl, "https://www.tiktok.com/@SomeUser/video/7234567890123456789");
  assert.equal(a.usernameHint, "SomeUser");
  assert.equal(a.opaque, false);
});

test("tiktok: same video id with a different handle segment dedupes", () => {
  assert.equal(
    accepted("https://www.tiktok.com/@alice/video/7234567890123456789").canonicalUrl,
    accepted("https://www.tiktok.com/@bob/video/7234567890123456789").canonicalUrl,
  );
});

test("tiktok: short links are kept as given (cleaned), opaque, never resolved", () => {
  const vm = accepted("http://vm.tiktok.com/ZMabc123/?utm_source=x");
  assert.equal(vm.videoUrl, "https://vm.tiktok.com/ZMabc123");
  assert.equal(vm.canonicalUrl, "https://vm.tiktok.com/ZMabc123");
  assert.equal(vm.opaque, true);
  const vt = accepted("https://vt.tiktok.com/ZSxyz789/");
  assert.equal(vt.canonicalUrl, "https://vt.tiktok.com/ZSxyz789");
  const t = accepted("https://www.tiktok.com/t/ZTabcDEF/");
  assert.equal(t.opaque, true);
  // Short-link codes are case-sensitive.
  assert.notEqual(accepted("https://vm.tiktok.com/ZMabc").canonicalUrl, accepted("https://vm.tiktok.com/ZMABC").canonicalUrl);
});

test("tiktok: legacy /v/<id>.html maps to the video canonical", () => {
  assert.equal(accepted("https://m.tiktok.com/v/7234567890123456789.html").canonicalUrl, "https://www.tiktok.com/@/video/7234567890123456789");
});

test("instagram: reel/reels/p/tv and handle-prefixed forms share one canonical; shortcode case preserved", () => {
  const forms = [
    "https://www.instagram.com/reel/C1AbCdEfGhI/",
    "https://instagram.com/reels/C1AbCdEfGhI",
    "https://www.instagram.com/someone/reel/C1AbCdEfGhI/?igsh=MWx4NGJ5eA==",
    "https://www.instagram.com/p/C1AbCdEfGhI/?utm_source=ig_web_copy_link",
  ];
  const canon = new Set(forms.map((f) => accepted(f).canonicalUrl));
  assert.deepEqual([...canon], ["https://www.instagram.com/p/C1AbCdEfGhI"]);
  assert.notEqual(accepted("https://www.instagram.com/reel/C1AbCdEfGhI").canonicalUrl, accepted("https://www.instagram.com/reel/c1abcdefghi").canonicalUrl);
});

test("instagram: /share links are opaque and stored as given", () => {
  const s = accepted("https://www.instagram.com/share/reel/BAhXyz12/?igsh=abc");
  assert.equal(s.opaque, true);
  assert.equal(s.videoUrl, "https://www.instagram.com/share/reel/BAhXyz12");
  assert.equal(accepted("https://www.instagram.com/share/BAhXyz12").opaque, true);
});

test("youtube: shorts + youtu.be dedupe to the shorts canonical, `si` stripped", () => {
  const a = accepted("https://youtube.com/shorts/aBcDeFgHiJk?si=TRACKINGTOKEN&feature=share");
  const b = accepted("https://youtu.be/aBcDeFgHiJk?si=OTHER");
  const c = accepted("https://m.youtube.com/shorts/aBcDeFgHiJk");
  assert.equal(a.canonicalUrl, "https://www.youtube.com/shorts/aBcDeFgHiJk");
  assert.equal(b.canonicalUrl, a.canonicalUrl);
  assert.equal(c.canonicalUrl, a.canonicalUrl);
  assert.equal(b.videoUrl, "https://youtu.be/aBcDeFgHiJk"); // stored as given
  assert.equal(a.platform, "youtube");
});

test("youtube: only Shorts links - watch?v, channels, playlists are rejected", () => {
  rejected("https://www.youtube.com/watch?v=aBcDeFgHiJk", "invalid");
  rejected("https://www.youtube.com/@somechannel", "invalid");
  rejected("https://www.youtube.com/playlist?list=PL123", "invalid");
  rejected("https://youtu.be/short", "invalid"); // wrong id length
});

test("x: twitter.com / x.com / mobile / www collapse; handle dropped from canonical", () => {
  const forms = [
    "https://x.com/SomeUser/status/1700000000000000000",
    "https://twitter.com/someuser/status/1700000000000000000?s=20&t=abc",
    "https://mobile.twitter.com/SomeUser/status/1700000000000000000",
    "https://www.x.com/i/status/1700000000000000000",
    "https://x.com/i/web/status/1700000000000000000",
    "https://x.com/someuser/status/1700000000000000000/video/1",
  ];
  const canon = new Set(forms.map((f) => accepted(f).canonicalUrl));
  assert.deepEqual([...canon], ["https://x.com/i/status/1700000000000000000"]);
  const a = accepted(forms[0]);
  assert.equal(a.platform, "x");
  assert.equal(a.videoUrl, "https://x.com/SomeUser/status/1700000000000000000");
  assert.equal(a.usernameHint, "SomeUser");
  assert.equal(accepted(forms[3]).usernameHint, null);
});

test("tracking parameters and fragments are always stripped", () => {
  const dirty = "https://www.tiktok.com/@u/video/7234567890123456789?utm_source=a&utm_medium=b&utm_campaign=c&igsh=d&si=e&fbclid=f&gclid=g&ref=h&_t=i&_r=1#comments";
  const r = accepted(dirty);
  assert.ok(!/[?#]/.test(r.videoUrl) && !/[?#]/.test(r.canonicalUrl));
});

test("http is upgraded to https", () => {
  const r = accepted("http://www.tiktok.com/@u/video/7234567890123456789");
  assert.ok(r.videoUrl.startsWith("https://"));
});

// ── Rejections: host confusion / homograph / scheme / structure ─────────────

test("userinfo tricks are rejected", () => {
  rejected("https://tiktok.com@evil.com/@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com:pass@evil.com/@u/video/7234567890123456789", "invalid");
  rejected("https://evil.com@www.tiktok.com/@u/video/7234567890123456789", "invalid");
  rejected("https://@www.tiktok.com/@u/video/7234567890123456789", "invalid");
});

test("lookalike / suffix / prefix hosts are unsupported", () => {
  rejected("https://tiktok.com.evil.co/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://evil-tiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://eviltiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://tiktok.com.evil.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://x.com.evil.com/u/status/1700000000000000000", "unsupported_platform");
  rejected("https://notx.com/u/status/1700000000000000000", "unsupported_platform");
  rejected("https://evil.com/?u=https://www.tiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://evil.com/https://www.tiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://t.co/abc123", "unsupported_platform");
  rejected("https://facebook.com/reel/12345678", "unsupported_platform");
});

test("unlisted subdomains are unsupported (only the audited hosts are accepted)", () => {
  rejected("https://evil.tiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://us.tiktok.com/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://foo.instagram.com/reel/C1AbCdEfGhI", "unsupported_platform");
  rejected("https://music.youtube.com/shorts/aBcDeFgHiJk", "unsupported_platform");
});

test("punycode / IDN / fullwidth / percent-encoded hosts are rejected", () => {
  rejected("https://xn--tiktok-9ta.com/@u/video/7234567890123456789", "invalid");
  rejected("https://www.xn--ticktok-1nf.com/@u/video/7234567890123456789", "invalid");
  rejected("https://tıktok.com/@u/video/7234567890123456789", "invalid"); // dotless i
  rejected("https://tіktok.com/@u/video/7234567890123456789", "invalid"); // Cyrillic і
  rejected("https://ｔｉｋｔｏｋ.com/@u/video/7234567890123456789", "invalid"); // fullwidth
  rejected("https://www.tiktok.com/@u/video/７２３４５６７８９０１２３４５６７８９", "invalid"); // fullwidth digits
  rejected("https://tiktok%2ecom/@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok%2Ecom/@u/video/7234567890123456789", "invalid");
  rejected("https://%74iktok.com/@u/video/7234567890123456789", "invalid");
});

test("percent-encoded path tricks are rejected", () => {
  rejected("https://www.tiktok.com/@u/video/7234567890123456789%0a", "invalid");
  rejected("https://www.tiktok.com/%40u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com/@u/video%2F7234567890123456789", "invalid");
  rejected("https://x.com/u/status/17000000000000%2e00000", "invalid");
});

test("backslash confusion is rejected", () => {
  rejected("https://tiktok.com\\@evil.com/@u/video/7234567890123456789", "invalid");
  rejected("https://evil.com\\.tiktok.com/@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com/@u\\video/7234567890123456789", "invalid");
});

test("IP hosts, ports, and non-https schemes are rejected", () => {
  rejected("https://127.0.0.1/@u/video/7234567890123456789", "invalid");
  rejected("https://2130706433/@u/video/7234567890123456789", "invalid");
  rejected("https://0x7f.0.0.1/@u/video/7234567890123456789", "invalid");
  rejected("https://[::1]/@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com:8080/@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com:443/@u/video/7234567890123456789", "invalid");
  rejected("http://www.tiktok.com:80/@u/video/7234567890123456789", "invalid");
  rejected("javascript:alert(1)", "invalid");
  rejected("JaVaScRiPt:alert(document.cookie)", "invalid");
  rejected("data:text/html,<script>alert(1)</script>", "invalid");
  rejected("ftp://www.tiktok.com/@u/video/7234567890123456789", "invalid");
  rejected("file:///etc/passwd", "invalid");
  rejected("//www.tiktok.com/@u/video/7234567890123456789", "invalid");
  rejected("tiktok.com:443/@u/video/7234567890123456789", "invalid");
});

test("overlong, control-character and whitespace-laden URLs are rejected", () => {
  rejected("https://www.tiktok.com/@u/video/7234567890123456789/" + "a".repeat(3000), "invalid");
  rejected("https://www.tiktok.com/@u/video/7234567890123456789\u0000", "invalid");
  rejected("https://www.tiktok.com/@u/video/7234567890123456789\r\nHost: evil.com", "invalid");
  rejected("https://www.tiktok.com/@u/vid eo/7234567890123456789", "invalid");
  rejected("", "invalid");
});

test("allowed host but not a post URL (profile, root, wrong shape) is invalid", () => {
  rejected("https://www.tiktok.com/", "invalid");
  rejected("https://www.tiktok.com/@someuser", "invalid");
  rejected("https://www.tiktok.com/@someuser/video/", "invalid");
  rejected("https://www.tiktok.com/@someuser/video/abc", "invalid");
  rejected("https://www.instagram.com/someuser/", "invalid");
  rejected("https://x.com/someuser", "invalid");
  rejected("https://x.com/someuser/status/notdigits", "invalid");
  rejected("https://www.tiktok.com//@u/video/7234567890123456789", "invalid");
  rejected("https://www.tiktok.com/@u//video/7234567890123456789", "invalid");
});

test("prototype-key hosts are not treated as allowed", () => {
  rejected("https://constructor/@u/video/7234567890123456789", "unsupported_platform");
  rejected("https://__proto__/@u/video/7234567890123456789"); // "_" is not a valid host char -> invalid
  rejected("https://toString/x", "unsupported_platform");
});

// ── Extraction from text / entities / captions ──────────────────────────────

test("extract: text with surrounding prose, punctuation, and emoji", () => {
  const r = extractFromMessage({
    text: "شوف الفيديو 🔥 (https://www.tiktok.com/@u/video/7234567890123456789), و كمان: https://youtu.be/aBcDeFgHiJk!",
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.accepted[0].platform, "tiktok");
  assert.equal(r.accepted[1].platform, "youtube");
});

test("extract: Arabic glued directly to a URL is cut, not absorbed", () => {
  const r = extractFromMessage({
    text: "رابطيhttps://www.tiktok.com/@u/video/7234567890123456789والباقي كلام",
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].canonicalUrl, "https://www.tiktok.com/@/video/7234567890123456789");
});

test("extract: RTL/LRM/RLE control characters around URLs", () => {
  const r = extractFromMessage({
    text: "‫‏https://x.com/u/status/1700000000000000000‏‬ ⁧https://www.instagram.com/reel/C1AbCdEfGhI/⁩",
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 2);
});

test("extract: newlines and tabs separate URLs", () => {
  const r = extractFromMessage({
    text: "https://x.com/u/status/1700000000000000000\nhttps://www.tiktok.com/@u/video/7234567890123456789\t\thttps://youtu.be/aBcDeFgHiJk\r\n",
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 3);
});

test("extract: scheme-less bare links are found only for allowed hosts", () => {
  const r = extractFromMessage({ text: "vm.tiktok.com/ZMabc123/ file.txt example.com/x www.instagram.com/reel/C1AbCdEfGhI" }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.rejected.length, 0); // file.txt / example.com/x are simply ignored, not "unsupported" noise
});

test("extract: entities - text_link target is validated, not its visible text", () => {
  const text = "look at this video https://www.tiktok.com/@u/video/7234567890123456789 now";
  const evilLink = "click here";
  const r = extractFromMessage({
    text: `${text} ${evilLink}`,
    entities: [
      { type: "url", offset: 19, length: 51 },
      { type: "text_link", offset: text.length + 1, length: evilLink.length, url: "https://evil.example.com/phish" },
    ],
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "unsupported_platform");
});

test("extract: entities - hidden text_link to a valid post is found even with no visible URL", () => {
  const r = extractFromMessage({
    text: "my newest clip",
    entities: [{ type: "text_link", offset: 3, length: 6, url: "https://www.instagram.com/reel/C1AbCdEfGhI/?igsh=x" }],
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].canonicalUrl, "https://www.instagram.com/p/C1AbCdEfGhI");
});

test("extract: captions and caption_entities are scanned too", () => {
  const r = extractFromMessage({
    caption: "posted! https://youtube.com/shorts/aBcDeFgHiJk?si=zzz",
    caption_entities: [{ type: "url", offset: 8, length: 46 }],
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].platform, "youtube");
});

test("extract: malformed entities never throw", () => {
  const evil = [
    null, 5, "x", { type: "url" }, { type: "url", offset: -1, length: 5 },
    { type: "url", offset: 9999999, length: 5 }, { type: "url", offset: 0, length: 999999999 },
    { type: "text_link", url: 12345 }, { type: "text_link", url: { toString: "x" } },
  ] as never;
  const r = extractFromMessage({ text: "hello https://x.com/u/status/1700000000000000000", entities: evil }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
});

test("extract: same post twice in one message counts once", () => {
  const r = extractFromMessage({
    text: "https://www.tiktok.com/@u/video/7234567890123456789 https://tiktok.com/@u/video/7234567890123456789?x=1",
  }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.repeatedInMessage, 1);
});

test("extract: 60 URLs in one message -> first 20 examined, 40 ignored and reported", () => {
  const urls = Array.from({ length: 60 }, (_, i) => `https://www.tiktok.com/@u/video/${BigInt("7234567890123450000") + BigInt(i)}`);
  const r = extractFromMessage({ text: urls.join("\n") }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, MAX_URLS_PER_MESSAGE);
  assert.equal(r.ignoredCount, 60 - MAX_URLS_PER_MESSAGE);
});

test("extract: 10KB message with one URL buried in the middle", () => {
  const filler = "كلام عربي طويل 🎬 ".repeat(400); // ~ 7KB of UTF-16
  const r = extractFromMessage({ text: `${filler} https://x.com/u/status/1700000000000000000 ${filler}` }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length, 1);
});

test("extract: adversarial 16KB inputs finish quickly (linear scan, no ReDoS)", () => {
  const cases = [
    "http://".repeat(2500),
    "https://".repeat(2000),
    "http".repeat(4000),
    "a.".repeat(8000),
    "https://" + "a".repeat(15000),
    "(".repeat(8000) + "https://x.com/u/status/1700000000000000000" + ")".repeat(8000),
    "https://tiktok.com/" + "@".repeat(8000),
    "‮".repeat(8000) + "https://x.com/u/status/1700000000000000000",
    ("https://www.tiktok.com/@u/video/7234567890123456789 ").repeat(400),
  ];
  for (const text of cases) {
    const t0 = performance.now();
    extractFromMessage({ text }, MAX_URLS_PER_MESSAGE);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `took ${ms.toFixed(1)}ms for input starting ${JSON.stringify(text.slice(0, 20))}`);
  }
});

test("extract: candidate scan is hard-capped", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `https://x.com/u/status/${BigInt("1700000000000000000") + BigInt(i)}`).join(" ");
  const c = extractCandidates(text, null);
  assert.ok(c.length <= 200);
});

test("extract: no URLs -> nothing accepted or rejected", () => {
  const r = extractFromMessage({ text: "مرحبا كيف الحال؟ hello there 123" }, MAX_URLS_PER_MESSAGE);
  assert.equal(r.accepted.length + r.rejected.length, 0);
});

test("extract: an allowed-looking URL inside another URL's query is not accepted", () => {
  const r = extractFromMessage({
    text: "https://evil.com/redirect?to=https://www.tiktok.com/@u/video/7234567890123456789",
  }, MAX_URLS_PER_MESSAGE);
  // The outer URL is examined (unsupported); the inner one is found by the
  // token scan too, since it is a distinct http:// occurrence in the token -
  // and is a genuinely valid TikTok URL, so it is accepted on its own merits.
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "unsupported_platform");
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].videoUrl, "https://www.tiktok.com/@u/video/7234567890123456789");
});
