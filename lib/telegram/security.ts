import crypto from "node:crypto";

/**
 * Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header
 * against the configured secret. Both sides are hashed to a fixed length
 * first, so `timingSafeEqual` (which throws on unequal lengths) is always
 * legal and the comparison time does not depend on where the strings first
 * differ, nor reveal the secret's length.
 */
export function verifyWebhookSecret(header: string | null | undefined, expected: string): boolean {
  if (!expected) return false; // an unset secret must never authenticate anything
  const a = crypto.createHash("sha256").update(header ?? "", "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b) && typeof header === "string" && header.length > 0;
}

export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Read the request body with a HARD byte cap, streaming: a body that lies
 * about (or omits) Content-Length still cannot make us buffer more than
 * `maxBytes`. On overflow the stream is cancelled.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
