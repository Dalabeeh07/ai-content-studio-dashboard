import type { BotApi } from "./api";
import { MAX_BODY_BYTES, UPDATE_MAX_ATTEMPTS, UPDATE_STALE_SECONDS } from "./config";
import { handleUpdate } from "./handler";
import { readBodyCapped, verifyWebhookSecret } from "./security";
import type { Store } from "./store";
import { parseUpdate } from "./types";

export interface WebhookDeps {
  /** TELEGRAM_WEBHOOK_SECRET; empty/undefined means "not configured" and fails closed. */
  secret: string;
  store: Store;
  bot: BotApi;
  hashCode: (code: string) => string;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The whole webhook, separated from the Next.js route so tests can drive it
 * with a real Request and injected dependencies.
 *
 * Status contract (documented deviation from "always 200"):
 *   401  missing/wrong secret. ZERO database access, body never read.
 *   413  body over MAX_BODY_BYTES (only reachable with a valid secret).
 *   503  server not configured, OR the datastore is unreachable BEFORE the
 *        update was claimed. Nothing was processed, so Telegram's retry is
 *        exactly what we want: it avoids silently losing a creator's link
 *        during a database blip.
 *   200  everything else - handled, ignored, duplicate, malformed, or failed
 *        AFTER claiming. Failures after the claim are recorded (status
 *        'failed') and the user is told to retry; we do not ask Telegram to
 *        redeliver something we may have half-processed.
 */
export async function processWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  // 1. Authenticate FIRST, in constant time, before reading the body or touching the DB.
  if (!deps.secret) {
    console.error("telegram webhook: TELEGRAM_WEBHOOK_SECRET is not configured");
    return json({ error: "Service not configured" }, 503);
  }
  if (!verifyWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"), deps.secret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  // 2. Size-capped read.
  const body = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large" ? json({ error: "Payload too large" }, 413) : json({ ok: true, ignored: "unreadable" }, 200);
  }

  // 3. Parse + validate. Anything we do not handle is acknowledged and dropped
  //    here, before any write (edited messages, groups, channels, bots, ...).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return json({ ok: true, ignored: "malformed_json" }, 200);
  }
  const update = parseUpdate(parsed);
  if (!update) return json({ ok: true, ignored: "unsupported_update" }, 200);

  // 4. Idempotency: Telegram redelivers on slow/non-2xx responses.
  let claim: "new" | "retry" | "duplicate";
  try {
    claim = await deps.store.claimUpdate(update.update_id, UPDATE_STALE_SECONDS, UPDATE_MAX_ATTEMPTS);
  } catch (err) {
    console.error(`telegram webhook: claim failed: ${err instanceof Error ? err.name : "unknown"}`);
    return json({ error: "Temporarily unavailable" }, 503);
  }
  if (claim === "duplicate") return json({ ok: true, duplicate: true }, 200);

  // 5. Handle. Nothing below may throw out of this function.
  let status: "done" | "failed" = "done";
  try {
    await handleUpdate(update, { store: deps.store, bot: deps.bot, hashCode: deps.hashCode });
  } catch {
    status = "failed"; // already logged (sanitised) by the handler
  }
  try {
    await deps.store.finishUpdate(update.update_id, status);
  } catch (err) {
    console.error(`telegram webhook: could not finish update: ${err instanceof Error ? err.name : "unknown"}`);
  }
  return json({ ok: true }, 200);
}
