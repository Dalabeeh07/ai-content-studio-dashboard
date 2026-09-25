// URL extraction + hardening pipeline for the Telegram link-intake bot.
//
// PURE and dependency-free (no I/O, no network): this module never fetches,
// resolves or follows a URL. That is a deliberate SSRF/slowness decision -
// short links (vm.tiktok.com, vt.tiktok.com, instagram.com/share/...) are
// stored exactly as given (cleaned), flagged `opaque`, and NOT expanded. The
// founder's export shows them as-is; Whop resolves them itself.
//
// Security model, in order of precedence:
//   1. Never trust a substring match on a host. The candidate is parsed with
//      the WHATWG URL parser and only the parsed hostname is compared, by
//      exact membership in ALLOWED_HOSTS (no "endsWith", no "includes").
//   2. The RAW authority (text between "://" and the first "/?#") is
//      inspected BEFORE parsing and rejected on anything that the parser
//      would silently "fix" into a lookalike: userinfo ("@"), percent-
//      encoding, non-ASCII (fullwidth / homograph / punycode), brackets,
//      backslashes, explicit ports. Parsing alone is not enough: WHATWG
//      normalises fullwidth "ｔｉｋｔｏｋ.com" to the real tiktok.com, which is
//      semantically fine but we prefer rejecting anything a human would not
//      type by hand.
//   2b. Backslashes are rejected outright: WHATWG treats "\" as "/" in
//      special schemes, so "https://tiktok.com\@evil.com" parses to host
//      tiktok.com - a classic confusion primitive.
//   3. Every accepted URL is REBUILT from validated parts (platform, id,
//      handle), never echoed. All query strings and fragments are dropped -
//      no supported post shape needs a query param to be identified, so this
//      strips utm_*, igsh, si, fbclid, feature, s, t, _r, etc. in one stroke.
//   4. All scanning is linear (split + indexOf, no backtracking regexes over
//      attacker text) and bounded by MAX_TEXT_CHARS / MAX_CANDIDATES_SCANNED,
//      so a 10KB message of "http" fragments cannot burn CPU.

import {
  MAX_CANDIDATES_SCANNED,
  MAX_TEXT_CHARS,
  MAX_URL_LENGTH,
} from "./config";

export type Platform = "tiktok" | "instagram" | "youtube" | "x";

export interface AcceptedUrl {
  ok: true;
  platform: Platform;
  /** Cleaned, https, tracking-free URL as the founder should paste it into Whop. */
  videoUrl: string;
  /** Dedupe identity. URL-shaped, NOT guaranteed openable (e.g. handle dropped). */
  canonicalUrl: string;
  /** True for short links we deliberately do not resolve (vm./vt./share links). */
  opaque: boolean;
  /** Platform handle when it can be read out of the URL (tiktok/x), else null. */
  usernameHint: string | null;
  raw: string;
}

export type RejectReason = "invalid" | "unsupported_platform";

export interface RejectedUrl {
  ok: false;
  reason: RejectReason;
  raw: string;
}

export type UrlResult = AcceptedUrl | RejectedUrl;

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

// ── Host allow-list (exact membership only) ─────────────────────────────────

type HostKind =
  | "tiktok-web"      // tiktok.com / www. / m.
  | "tiktok-short"    // vm. / vt.
  | "instagram"
  | "youtube-web"     // youtube.com / www. / m.
  | "youtube-short"   // youtu.be
  | "x";

const ALLOWED_HOSTS: Record<string, HostKind> = {
  "tiktok.com": "tiktok-web",
  "www.tiktok.com": "tiktok-web",
  "m.tiktok.com": "tiktok-web",
  "vm.tiktok.com": "tiktok-short",
  "vt.tiktok.com": "tiktok-short",
  "instagram.com": "instagram",
  "www.instagram.com": "instagram",
  "youtube.com": "youtube-web",
  "www.youtube.com": "youtube-web",
  "m.youtube.com": "youtube-web",
  "youtu.be": "youtube-short",
  "x.com": "x",
  "www.x.com": "x",
  "mobile.x.com": "x",
  "twitter.com": "x",
  "www.twitter.com": "x",
  "mobile.twitter.com": "x",
};

// hasOwn guards against prototype keys like "constructor"/"__proto__" ever
// being treated as an allowed host.
function hostKind(host: string): HostKind | null {
  return Object.prototype.hasOwnProperty.call(ALLOWED_HOSTS, host)
    ? ALLOWED_HOSTS[host]
    : null;
}

// ── Segment validators (strict, ASCII-only, no percent-encoding) ────────────

const RE_TT_HANDLE = /^@[A-Za-z0-9._]{1,64}$/;
const RE_DIGITS_ID = /^[0-9]{5,25}$/;
const RE_TT_LEGACY = /^([0-9]{5,25})\.html$/;
const RE_SHORT_CODE = /^[A-Za-z0-9_-]{4,40}$/;
const RE_IG_CODE = /^[A-Za-z0-9_-]{5,30}$/;
const RE_IG_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const RE_YT_ID = /^[A-Za-z0-9_-]{11}$/;
const RE_X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/;
const NON_ASCII = /[^\u0000-\u007f]/;

function reject(raw: string, reason: RejectReason): RejectedUrl {
  return { ok: false, reason, raw };
}

// ── Classification of ONE candidate string ──────────────────────────────────

/**
 * Validate, normalise and canonicalise a single candidate URL.
 * `raw` may or may not carry a scheme (Telegram "url" entities and pasted
 * "tiktok.com/@x/video/1" often do not).
 */
export function classifyUrl(rawIn: string): UrlResult {
  const raw = rawIn.trim();

  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return reject(raw.slice(0, 200), "invalid");
  if (CONTROL_OR_SPACE.test(raw) || NON_ASCII.test(raw)) return reject(raw.slice(0, 200), "invalid");
  // Backslash: WHATWG treats it as "/" for special schemes -> host confusion.
  if (raw.includes("\\")) return reject(raw.slice(0, 200), "invalid");
  // Characters that can never appear in a legit supported URL.
  if (/[<>"`{}|^]/.test(raw)) return reject(raw.slice(0, 200), "invalid");

  // ── Scheme ────────────────────────────────────────────────────────────
  let withScheme: string;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (schemeMatch && raw.slice(schemeMatch[0].length).startsWith("//")) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return reject(raw.slice(0, 200), "invalid");
    withScheme = raw; // http is upgraded to https when we rebuild below
  } else if (schemeMatch && !raw.startsWith("//")) {
    // "javascript:alert(1)", "data:text/html,...", "mailto:x", and also the
    // scheme-less-with-port shape "tiktok.com:443/x" (schemeMatch treats
    // "tiktok.com" as a scheme) - none are a plain web URL, all rejected.
    return reject(raw.slice(0, 200), "invalid");
  } else if (raw.startsWith("//")) {
    return reject(raw.slice(0, 200), "invalid"); // scheme-relative
  } else {
    withScheme = `https://${raw}`;
  }

  // ── Raw authority inspection (BEFORE the parser can "fix" anything) ────
  const afterScheme = withScheme.slice(withScheme.indexOf("://") + 3);
  const authEnd = afterScheme.search(/[/?#]/);
  const authority = authEnd === -1 ? afterScheme : afterScheme.slice(0, authEnd);
  if (authority.length === 0) return reject(raw.slice(0, 200), "invalid");
  // userinfo, percent-encoding, IPv6 brackets, explicit ports - all rejected
  // on the RAW text. (A default port such as ":443" is never typed by hand;
  // rejecting every ":" is simpler and safer than allow-listing it.)
  if (/[@%[\]:]/.test(authority)) return reject(raw.slice(0, 200), "invalid");
  if (!/^[A-Za-z0-9.-]+$/.test(authority)) return reject(raw.slice(0, 200), "invalid");

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return reject(raw.slice(0, 200), "invalid");
  }

  if (u.username !== "" || u.password !== "") return reject(raw.slice(0, 200), "invalid");
  if (u.port !== "") return reject(raw.slice(0, 200), "invalid");

  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1); // "tiktok.com." is the same host
  if (host.includes("xn--")) return reject(raw.slice(0, 200), "invalid"); // punycode / IDN
  if (/^[0-9.]+$/.test(host) || host.startsWith("[")) return reject(raw.slice(0, 200), "invalid"); // IP host

  const kind = hostKind(host);
  if (!kind) return reject(raw.slice(0, 200), "unsupported_platform");

  // ── Path segments ─────────────────────────────────────────────────────
  const segs = u.pathname.split("/");
  segs.shift(); // leading "" before the first "/"
  if (segs.length > 0 && segs[segs.length - 1] === "") segs.pop(); // ONE trailing slash is fine
  if (segs.length === 0 || segs.length > 6) return reject(raw.slice(0, 200), "invalid");
  if (segs.some((s) => s === "" || s.includes("%"))) return reject(raw.slice(0, 200), "invalid");

  const bad = () => reject(raw.slice(0, 200), "invalid");

  switch (kind) {
    case "tiktok-web": {
      // /@handle/video/<id>
      if (segs.length === 3 && RE_TT_HANDLE.test(segs[0]) && segs[1].toLowerCase() === "video" && RE_DIGITS_ID.test(segs[2])) {
        const handle = segs[0];
        return {
          ok: true, platform: "tiktok", opaque: false, raw,
          videoUrl: `https://www.tiktok.com/${handle}/video/${segs[2]}`,
          canonicalUrl: `https://www.tiktok.com/@/video/${segs[2]}`,
          usernameHint: handle.slice(1),
        };
      }
      // /v/<id>.html  (legacy mobile share)
      if (segs.length === 2 && segs[0].toLowerCase() === "v") {
        const m = RE_TT_LEGACY.exec(segs[1]);
        if (m) {
          const url = `https://www.tiktok.com/@/video/${m[1]}`;
          return { ok: true, platform: "tiktok", opaque: false, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
        }
      }
      // /t/<code>  (www.tiktok.com short share)
      if (segs.length === 2 && segs[0].toLowerCase() === "t" && RE_SHORT_CODE.test(segs[1])) {
        const url = `https://www.tiktok.com/t/${segs[1]}`;
        return { ok: true, platform: "tiktok", opaque: true, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
      }
      return bad();
    }
    case "tiktok-short": {
      if (segs.length === 1 && RE_SHORT_CODE.test(segs[0])) {
        const url = `https://${host}/${segs[0]}`;
        return { ok: true, platform: "tiktok", opaque: true, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
      }
      return bad();
    }
    case "instagram": {
      // /share/<code> or /share/(reel|p)/<code>  -> opaque share link
      if (segs[0].toLowerCase() === "share") {
        if (segs.length === 2 && RE_SHORT_CODE.test(segs[1])) {
          const url = `https://www.instagram.com/share/${segs[1]}`;
          return { ok: true, platform: "instagram", opaque: true, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
        }
        if (segs.length === 3 && ["reel", "p"].includes(segs[1].toLowerCase()) && RE_SHORT_CODE.test(segs[2])) {
          const url = `https://www.instagram.com/share/${segs[1].toLowerCase()}/${segs[2]}`;
          return { ok: true, platform: "instagram", opaque: true, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
        }
        return bad();
      }
      // /(reel|reels|p|tv)/<code>   or   /<handle>/(reel|reels|p|tv)/<code>
      let k: string | undefined;
      let code: string | undefined;
      if (segs.length === 2) { k = segs[0]; code = segs[1]; }
      else if (segs.length === 3 && RE_IG_HANDLE.test(segs[0])) { k = segs[1]; code = segs[2]; }
      if (k && code && ["reel", "reels", "p", "tv"].includes(k.toLowerCase()) && RE_IG_CODE.test(code)) {
        const kk = k.toLowerCase() === "reels" ? "reel" : k.toLowerCase();
        return {
          ok: true, platform: "instagram", opaque: false, raw,
          videoUrl: `https://www.instagram.com/${kk}/${code}`,
          // /p/<code> serves every media type, so all kinds dedupe to one key.
          // Shortcodes are CASE-SENSITIVE - never lower-cased.
          canonicalUrl: `https://www.instagram.com/p/${code}`,
          usernameHint: null,
        };
      }
      return bad();
    }
    case "youtube-web": {
      if (segs.length === 2 && segs[0].toLowerCase() === "shorts" && RE_YT_ID.test(segs[1])) {
        const url = `https://www.youtube.com/shorts/${segs[1]}`;
        return { ok: true, platform: "youtube", opaque: false, raw, videoUrl: url, canonicalUrl: url, usernameHint: null };
      }
      return bad(); // watch?v=, channels, playlists: not Shorts links
    }
    case "youtube-short": {
      if (segs.length === 1 && RE_YT_ID.test(segs[0])) {
        return {
          ok: true, platform: "youtube", opaque: false, raw,
          videoUrl: `https://youtu.be/${segs[0]}`,
          canonicalUrl: `https://www.youtube.com/shorts/${segs[0]}`,
          usernameHint: null,
        };
      }
      return bad();
    }
    case "x": {
      // /<handle>/status/<id>[/video/<n> | /photo/<n>]  ,  /i/status/<id>  ,  /i/web/status/<id>
      let handle: string | null = null;
      let id: string | undefined;
      let rest: string[] = [];
      if (segs.length >= 3 && segs[0].toLowerCase() === "i" && segs[1].toLowerCase() === "web" && segs[2].toLowerCase() === "status") {
        id = segs[3]; rest = segs.slice(4);
      } else if (segs.length >= 3 && segs[1].toLowerCase() === "status" && (segs[0].toLowerCase() === "i" || RE_X_HANDLE.test(segs[0]))) {
        handle = segs[0].toLowerCase() === "i" ? null : segs[0];
        id = segs[2]; rest = segs.slice(3);
      } else {
        return bad();
      }
      if (!id || !RE_DIGITS_ID.test(id)) return bad();
      if (rest.length !== 0 && !(rest.length === 2 && ["video", "photo"].includes(rest[0].toLowerCase()) && /^[0-9]{1,2}$/.test(rest[1]))) return bad();
      return {
        ok: true, platform: "x", opaque: false, raw,
        videoUrl: `https://x.com/${handle ?? "i"}/status/${id}`,
        canonicalUrl: `https://x.com/i/status/${id}`,
        usernameHint: handle,
      };
    }
  }
}

// ── Candidate extraction from message text / entities ───────────────────────

// Whitespace plus zero-width and bidi-control characters (Arabic text is full
// of them: RLM/LRM/embedding/isolate marks glue themselves to pasted URLs).
const TOKEN_SPLIT = /[\s​-‏‪-‮⁦-⁩﻿]+/;
const LEADING_PUNCT = /^[(<[{"'*]+/;
const TRAILING_PUNCT = /[.,;:!?)\]}>"'*]+$/;

function stripPunct(s: string): string {
  return s.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");
}

// Cut at the first character outside printable ASCII: an Arabic word (or an
// emoji) glued straight onto a URL must not become part of it, and a
// non-ASCII byte inside a host is never legitimate anyway.
function cutAtNonAscii(s: string): string {
  const i = s.search(/[^!-~]/);
  return i === -1 ? s : s.slice(0, i);
}

// True when a scheme-less token starts with an allow-listed host, e.g.
// "vm.tiktok.com/ZMabc/" or "youtu.be/abc". Used so bare pasted links are
// found WITHOUT treating every "file.txt"-looking token as a URL.
function startsWithAllowedHost(token: string): boolean {
  const end = token.search(/[/?#]/);
  if (end <= 0) return false;
  return hostKind(token.slice(0, end).toLowerCase()) !== null;
}

/**
 * Collect candidate URL strings from one text field (message text or
 * caption) plus its entities. Order is text order; duplicates are removed by
 * exact raw string. Linear time, hard-capped.
 */
export function extractCandidates(
  textIn: string | undefined | null,
  entities: TgEntity[] | undefined | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    if (c.length === 0 || seen.has(c) || out.length >= MAX_CANDIDATES_SCANNED) return;
    seen.add(c);
    out.push(c);
  };

  const text = typeof textIn === "string" ? textIn.slice(0, MAX_TEXT_CHARS) : "";

  // 1. Entities (Telegram tells us exactly where URLs are). "text_link" is a
  //    hyperlink whose VISIBLE text can differ from its target, so the target
  //    (entity.url) is what we validate.
  if (Array.isArray(entities)) {
    for (const e of entities.slice(0, 100)) {
      if (!e || typeof e !== "object") continue;
      if (e.type === "text_link" && typeof e.url === "string") {
        push(e.url.trim());
      } else if (
        e.type === "url" &&
        Number.isInteger(e.offset) && Number.isInteger(e.length) &&
        e.offset >= 0 && e.length > 0 && e.length <= MAX_URL_LENGTH
      ) {
        push(stripPunct(text.slice(e.offset, e.offset + e.length)));
      }
    }
  }

  // 2. Token scan of the plain text (catches URLs Telegram did not entity-tag,
  //    and everything in forged updates that carry no entities at all).
  for (const token of text.split(TOKEN_SPLIT)) {
    if (out.length >= MAX_CANDIDATES_SCANNED) break;
    if (token.length < 4) continue;
    const lower = token.toLowerCase();

    // Every "http://" / "https://" occurrence inside the token (Arabic text
    // frequently sits directly against the URL with no space).
    const starts: number[] = [];
    let pos = 0;
    while (starts.length < 8) {
      const i = lower.indexOf("http", pos);
      if (i === -1) break;
      if (lower.startsWith("://", i + 4) || (lower[i + 4] === "s" && lower.startsWith("://", i + 5))) {
        starts.push(i);
      }
      pos = i + 4;
    }
    if (starts.length > 0) {
      for (let k = 0; k < starts.length; k++) {
        const piece = token.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : undefined);
        push(stripPunct(cutAtNonAscii(piece)));
      }
      continue;
    }

    // Scheme-less bare link, only if it begins with an allowed host.
    const cleaned = stripPunct(cutAtNonAscii(stripPunct(token)));
    if (startsWithAllowedHost(cleaned)) push(cleaned);
  }

  return out;
}

export interface ExtractionResult {
  /** Accepted URLs, de-duplicated by canonical URL, in text order. */
  accepted: AcceptedUrl[];
  /** Rejected candidates (de-duplicated by raw string), in text order. */
  rejected: RejectedUrl[];
  /** Candidates beyond `maxUrls` that were not examined at all. */
  ignoredCount: number;
  /** Accepted URLs collapsed because the same post appeared twice. */
  repeatedInMessage: number;
}

/**
 * Full pipeline for one Telegram message: text + caption, with their
 * entities, capped at `maxUrls` candidates.
 */
export function extractFromMessage(
  msg: {
    text?: string | null;
    entities?: TgEntity[] | null;
    caption?: string | null;
    caption_entities?: TgEntity[] | null;
  },
  maxUrls: number,
): ExtractionResult {
  const all = [
    ...extractCandidates(msg.text, msg.entities),
    ...extractCandidates(msg.caption, msg.caption_entities),
  ];
  // De-dupe raw strings across text+caption while keeping order.
  const uniqueRaw: string[] = [];
  const seenRaw = new Set<string>();
  for (const c of all) {
    if (!seenRaw.has(c)) { seenRaw.add(c); uniqueRaw.push(c); }
  }

  const considered = uniqueRaw.slice(0, maxUrls);
  const ignoredCount = Math.max(0, uniqueRaw.length - considered.length);

  const accepted: AcceptedUrl[] = [];
  const rejected: RejectedUrl[] = [];
  const seenCanonical = new Set<string>();
  let repeatedInMessage = 0;

  for (const raw of considered) {
    const r = classifyUrl(raw);
    if (r.ok) {
      if (seenCanonical.has(r.canonicalUrl)) { repeatedInMessage++; continue; }
      seenCanonical.add(r.canonicalUrl);
      accepted.push(r);
    } else {
      rejected.push(r);
    }
  }
  return { accepted, rejected, ignoredCount, repeatedInMessage };
}
