// Central tunables for the Telegram link-intake bot. Everything a founder
// might reasonably want to change (rate limits, TTLs, caps) lives here so
// nothing is buried in handler code. Pure constants - safe to import from
// both server code and tests.

export const BOT_USERNAME = "PlovikaLinksBot"; // public handle, shown in dashboard instructions

// ── Request hardening ───────────────────────────────────────────────────────
// Telegram updates are a few KB at most (a 4096-char message is ~16KB of
// UTF-8 in the absolute worst case). 64KB leaves generous headroom for
// entities while still cutting off garbage cheaply.
export const MAX_BODY_BYTES = 64 * 1024;
// Text beyond this is never scanned for URLs (Telegram itself caps a message
// at 4096 chars; this only matters for forged/oversized payloads).
export const MAX_TEXT_CHARS = 16 * 1024;
export const MAX_URLS_PER_MESSAGE = 20;
export const MAX_URL_LENGTH = 2048;
// Absolute cap on candidates examined before the per-message URL cap, so a
// 10KB message stuffed with thousands of "http" fragments stays O(n).
export const MAX_CANDIDATES_SCANNED = 200;

// ── Rate limits (DB-backed, per telegram_user_id) ───────────────────────────
export const LINKS_PER_WINDOW = 30;            // accepted-shape URLs per window
export const LINKS_WINDOW_SECONDS = 10 * 60;   // 10 minutes
export const LINKS_PER_DAY = 300;              // per rolling 24h fixed window
export const DAY_WINDOW_SECONDS = 24 * 60 * 60;
// Any message at all (stops reply-spam / cost amplification from strangers).
export const MESSAGES_PER_WINDOW = 40;
export const MESSAGES_WINDOW_SECONDS = 60;
// /link attempts (brute-force protection) - counted whether or not they
// succeed, so guessing costs the same as a legit try.
export const LINK_ATTEMPTS_PER_USER = 5;
export const LINK_ATTEMPTS_WINDOW_SECONDS = 15 * 60;
// Global ceiling across ALL telegram accounts, so an attacker cycling
// throwaway accounts still faces a hard aggregate cap.
export const LINK_ATTEMPTS_GLOBAL = 300;
export const LINK_ATTEMPTS_GLOBAL_WINDOW_SECONDS = 10 * 60;

// ── Link codes ──────────────────────────────────────────────────────────────
export const LINK_CODE_LENGTH = 8;
// 31 symbols: no 0/O, 1/I/L (unambiguous when typed from a screenshot).
export const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const LINK_CODE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ── Campaign attribution ────────────────────────────────────────────────────
export const CAMPAIGN_WINDOW_HOURS = 48;
export const MAX_CAMPAIGN_CHOICES = 5;          // inline-keyboard buttons
export const CHOICE_TTL_SECONDS = 30 * 60;      // picker / unlink confirm expiry

// ── Idempotency ─────────────────────────────────────────────────────────────
// A claimed-but-unfinished update (function crashed mid-way) may be
// re-processed by a Telegram retry after this long, at most MAX_ATTEMPTS times.
export const UPDATE_STALE_SECONDS = 60;
export const UPDATE_MAX_ATTEMPTS = 3;

// ── Bot API client ──────────────────────────────────────────────────────────
export const BOT_API_TIMEOUT_MS = 4000;

// ── Retention (enforced by app/api/cron/cleanup via tg_cleanup) ─────────────
// telegram_updates:          3 days  (only needs to outlive Telegram's retry window)
// telegram_rate_limits:      2 days after the window ends
// telegram_pending_choices:  1 day after expiry
// telegram_link_codes:       30 days after expiry/use/revoke
// telegram_links (revoked):  90 days
// video_submissions:         kept (business records, not touched by cleanup)
export const RETENTION_DAYS = {
  updates: 3,
  rateLimits: 2,
  pendingChoices: 1,
  linkCodes: 30,
  revokedLinks: 90,
} as const;

// ── Founder tooling ─────────────────────────────────────────────────────────
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
export const EXPORT_MAX_ROWS = 50_000;          // hard cap so an export can't time out
export const EXPORT_CHUNK = 1000;
export const BULK_MAX_ROWS = 20_000;            // "select all matching" ceiling
export const BULK_MAX_IDS = 500;                // explicit id selections
