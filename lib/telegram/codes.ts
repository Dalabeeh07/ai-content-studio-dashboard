import crypto from "node:crypto";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH } from "./config";

// ── Link codes ──────────────────────────────────────────────────────────────
// 8 symbols from a 31-letter unambiguous alphabet (~39.6 bits). Short enough
// to type from a screenshot, and safe because: single-use, 7-day expiry,
// bound to one hwid, stored only as an HMAC, and brute force is throttled
// per Telegram account AND globally (see config.ts / the /link handler).

/** Cryptographically random code, e.g. "K7QMR2XP" (no modulo bias: randomInt). */
export function generateLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    out += LINK_CODE_ALPHABET[crypto.randomInt(0, LINK_CODE_ALPHABET.length)];
  }
  return out;
}

/** Human-friendly display form: "K7QM-R2XP". */
export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Canonicalise whatever a user typed/pasted: any case, with or without the
 * hyphen, stray spaces/dots/underscores. Returns null unless the result is
 * exactly LINK_CODE_LENGTH characters from the alphabet - so malformed input
 * never reaches the database or the attempt counter.
 */
export function normalizeLinkCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const cleaned = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (cleaned.length !== LINK_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!LINK_CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/**
 * Keyed hash stored in telegram_link_codes.code_hash. The HMAC key is
 * DERIVED from TELEGRAM_WEBHOOK_SECRET with a domain-separation label, so a
 * database leak alone cannot be turned into an offline brute force of the
 * ~40-bit code space, and no extra secret needs provisioning.
 * Rotating TELEGRAM_WEBHOOK_SECRET invalidates any outstanding (unused)
 * codes - they simply need regenerating from the Users page.
 */
export function hashLinkCode(code: string, secret: string): string {
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
  const key = crypto.createHmac("sha256", secret).update("plovika:tg-link-code:v1").digest();
  return crypto.createHmac("sha256", key).update(code, "utf8").digest("hex");
}

/** Random single-use token for inline-keyboard callbacks (64 bits, fits callback_data). */
export function newChoiceToken(): string {
  return crypto.randomBytes(8).toString("hex");
}
