#!/usr/bin/env node
// Registers (or inspects / removes) the Telegram webhook for @PlovikaLinksBot.
//
//   node scripts/set-telegram-webhook.mjs                 register the webhook
//   node scripts/set-telegram-webhook.mjs --drop-pending  ...and discard updates queued while it was unset
//   node scripts/set-telegram-webhook.mjs --info          show getWebhookInfo (read-only)
//   node scripts/set-telegram-webhook.mjs --delete        remove the webhook (rollback / go quiet)
//   node scripts/set-telegram-webhook.mjs --dry-run       validate the env and print what WOULD happen; no network
//
// Everything sensitive comes from ENVIRONMENT VARIABLES - never from arguments
// (arguments end up in shell history and process lists) and is never printed:
//
//   TELEGRAM_BOT_TOKEN       the bot token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  the secret_token; must equal the value set in Vercel
//                            (1-256 chars of A-Z a-z 0-9 _ - ; this script requires >= 16)
//   TELEGRAM_WEBHOOK_URL     public URL, exactly  https://<dashboard-domain>/api/telegram/webhook
//
// PowerShell, without leaving the values in history or on screen:
//   $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host "Bot token" -AsSecureString)))
//   (repeat for TELEGRAM_WEBHOOK_SECRET; set TELEGRAM_WEBHOOK_URL normally)
//   node scripts/set-telegram-webhook.mjs
// or keep them in dashboard/.env.local (git-ignored) and run:
//   node --env-file=.env.local scripts/set-telegram-webhook.mjs
//
// Registers allowed_updates ["message","callback_query"] ONLY: edited messages,
// channel posts, group traffic etc. are never even delivered (the handler
// would drop them anyway).

const WEBHOOK_PATH = "/api/telegram/webhook";
const ALLOWED_UPDATES = ["message", "callback_query"];

const args = new Set(process.argv.slice(2));
const known = new Set(["--info", "--delete", "--dry-run", "--drop-pending", "--help", "-h"]);
for (const a of args) {
  if (!known.has(a)) {
    console.error(`Unknown option: ${a}\nUse --help.`);
    process.exit(2);
  }
}
if (args.has("--help") || args.has("-h")) {
  console.log("Usage: node scripts/set-telegram-webhook.mjs [--info | --delete | --dry-run] [--drop-pending]\nSee the header of this file for the required environment variables.");
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const rawUrl = process.env.TELEGRAM_WEBHOOK_URL ?? "";

// Only tests may redirect the API, and only to loopback - a stray env var must
// never be able to send the bot token to a remote host.
let apiBase = "https://api.telegram.org";
const overrideBase = process.env.TELEGRAM_API_BASE ?? "";
if (overrideBase) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(overrideBase)) {
    console.error("TELEGRAM_API_BASE is only honoured for http://127.0.0.1 / http://localhost (tests). Unset it.");
    process.exit(2);
  }
  apiBase = overrideBase.replace(/\/+$/, "");
}

// ── Validation (messages never include the values) ──────────────────────────
const problems = [];
// The token is validated even for --dry-run, so a dry run proves the shell is set up correctly.
if (!token) problems.push("TELEGRAM_BOT_TOKEN is not set.");
else if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (expected <digits>:<letters/digits>).");
const needsUrlAndSecret = !args.has("--info") && !args.has("--delete");
if (needsUrlAndSecret) {
  if (!secret) problems.push("TELEGRAM_WEBHOOK_SECRET is not set.");
  else if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) problems.push("TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z a-z 0-9 _ - (Telegram's own rule, plus a minimum length).");
  if (!rawUrl) problems.push("TELEGRAM_WEBHOOK_URL is not set.");
}

let webhookUrl = null;
if (rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") problems.push("TELEGRAM_WEBHOOK_URL must be https.");
    if (u.username || u.password) problems.push("TELEGRAM_WEBHOOK_URL must not contain credentials.");
    if (u.search || u.hash) problems.push("TELEGRAM_WEBHOOK_URL must not have a query string or fragment (the secret travels in a header, not the URL).");
    if (u.port) problems.push("TELEGRAM_WEBHOOK_URL must not specify a port.");
    if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname) || u.hostname.endsWith(".local")) problems.push("TELEGRAM_WEBHOOK_URL must be a PUBLIC host; Telegram cannot reach localhost.");
    if (u.pathname !== WEBHOOK_PATH) problems.push(`TELEGRAM_WEBHOOK_URL path must be exactly ${WEBHOOK_PATH} (no trailing slash - Next.js would 308-redirect it and Telegram does not follow redirects).`);
    webhookUrl = `${u.origin}${u.pathname}`;
  } catch {
    problems.push("TELEGRAM_WEBHOOK_URL is not a valid URL.");
  }
}

if (problems.length > 0) {
  console.error("Cannot continue:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(2);
}

/** Origin + path only, with any long opaque path segment masked. */
function maskUrl(u) {
  if (typeof u !== "string" || u === "") return "(none)";
  try {
    const p = new URL(u);
    const path = p.pathname.split("/").map((seg) => (seg.length > 24 && /^[A-Za-z0-9_-]+$/.test(seg) ? `${seg.slice(0, 4)}…(masked)` : seg)).join("/");
    return `${p.origin}${path}${p.search ? "?(query hidden)" : ""}`;
  } catch {
    return "(unparseable url hidden)";
  }
}

/** Calls the Bot API. Never logs the request URL (it contains the token) and
 * never lets a raw error message escape (fetch errors can embed the URL). */
async function tg(method, body) {
  let res;
  try {
    res = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error(`Network error calling ${method}: ${err instanceof Error ? err.name : "unknown"} (details hidden: they can contain the token).`);
    process.exit(1);
  }
  let json = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !json || json.ok !== true) {
    const desc = json && typeof json.description === "string" ? json.description.slice(0, 200) : "no description";
    console.error(`Telegram rejected ${method}: HTTP ${res.status} - ${desc}`);
    process.exit(1);
  }
  return json.result;
}

function printInfo(info) {
  console.log("Webhook info:");
  console.log(`  url:                  ${maskUrl(info.url)}`);
  console.log(`  pending updates:      ${info.pending_update_count ?? 0}`);
  console.log(`  allowed_updates:      ${Array.isArray(info.allowed_updates) && info.allowed_updates.length ? info.allowed_updates.join(", ") : "(default: all except a few)"}`);
  console.log(`  max_connections:      ${info.max_connections ?? "(default)"}`);
  if (info.last_error_date) {
    console.log(`  last error:           ${new Date(info.last_error_date * 1000).toISOString()} - ${String(info.last_error_message ?? "").slice(0, 200)}`);
  } else {
    console.log("  last error:           none");
  }
  if (info.last_synchronization_error_date) {
    console.log(`  last sync error:      ${new Date(info.last_synchronization_error_date * 1000).toISOString()}`);
  }
}

async function main() {
  if (args.has("--info")) {
    if (args.has("--dry-run")) { console.log("[dry-run] would call getWebhookInfo"); return; }
    printInfo(await tg("getWebhookInfo"));
    return;
  }

  if (args.has("--delete")) {
    if (args.has("--dry-run")) { console.log(`[dry-run] would call deleteWebhook (drop_pending_updates=${args.has("--drop-pending")})`); return; }
    await tg("deleteWebhook", { drop_pending_updates: args.has("--drop-pending") });
    console.log("Webhook deleted.");
    return;
  }

  const body = {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: args.has("--drop-pending"),
    max_connections: 20,
  };
  if (args.has("--dry-run")) {
    console.log("[dry-run] environment is valid. Would call setWebhook with:");
    console.log(`  url:                  ${maskUrl(webhookUrl)}`);
    console.log("  secret_token:         (set, hidden)");
    console.log(`  allowed_updates:      ${ALLOWED_UPDATES.join(", ")}`);
    console.log(`  drop_pending_updates: ${body.drop_pending_updates}`);
    return;
  }

  await tg("setWebhook", body);
  console.log(`Webhook registered: ${maskUrl(webhookUrl)}`);
  console.log("  secret_token:         set (hidden)");
  console.log(`  allowed_updates:      ${ALLOWED_UPDATES.join(", ")}`);
  console.log(`  drop_pending_updates: ${body.drop_pending_updates}`);
  console.log("\nVerify with:  node scripts/set-telegram-webhook.mjs --info");
}

main().catch(() => {
  // Deliberately generic: an unexpected error object could carry the token.
  console.error("Unexpected error (details hidden).");
  process.exit(1);
});
