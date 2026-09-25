import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fakeTelegram";

// The token/secret below are FAKE, distinctive strings. Every test scans the
// script's entire stdout+stderr for them: the script must never echo either.
const TOKEN = "123456789:FAKE_TOKEN_abcdefghijklmnopqrstuvwxyz012345";
const SECRET = "FAKE_SECRET_value_0123456789_abcdef";
const URL_OK = "https://dashboard.example.com/api/telegram/webhook";
const SCRIPT = path.resolve(process.cwd(), "scripts", "set-telegram-webhook.mjs");

let fake: FakeTelegram;
before(async () => { fake = await startFakeTelegram(); });
after(async () => { await fake.close(); });

// Async (NOT spawnSync): the fake Telegram server lives in THIS process, and a
// blocking spawn would freeze its event loop so it could never answer the child.
function run(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  const clean: Record<string, string> = {};
  // Start from a minimal env so the developer's real TELEGRAM_* vars can never leak into a test.
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k]) clean[k] = process.env[k] as string;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: clean as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`script timed out:\n${out}`)); }, 30000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.ok(!out.includes(TOKEN) && !out.includes(SECRET) && !out.includes(TOKEN.split(":")[1]), `secret leaked into output:\n${out}`);
        resolve({ code, out });
      } catch (e) { reject(e); }
    });
  });
}
const goodEnv = () => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_URL: URL_OK, TELEGRAM_API_BASE: fake.url });

test("setWebhook: sends the secret_token + allowed_updates, prints neither secret", async () => {
  fake.calls.length = 0;
  const r = await run([], goodEnv());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Webhook registered: https:\/\/dashboard\.example\.com\/api\/telegram\/webhook/);
  const call = fake.calls.find((c) => c.method === "setWebhook")!;
  assert.ok(call);
  assert.equal(call.tokenSeen, TOKEN);
  assert.equal(call.body.url, URL_OK);
  assert.equal(call.body.secret_token, SECRET);
  assert.deepEqual(call.body.allowed_updates, ["message", "callback_query"]);
  assert.equal(call.body.drop_pending_updates, false);
});

test("--drop-pending is forwarded", async () => {
  fake.calls.length = 0;
  assert.equal((await run(["--drop-pending"], goodEnv())).code, 0);
  assert.equal(fake.calls.find((c) => c.method === "setWebhook")!.body.drop_pending_updates, true);
});

test("--info prints getWebhookInfo with the URL masked and never the secrets", async () => {
  fake.webhookInfo = {
    url: "https://dashboard.example.com/api/telegram/webhook/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?secret=hunter2",
    pending_update_count: 3, allowed_updates: ["message", "callback_query"], max_connections: 20,
    last_error_date: 1_700_000_000, last_error_message: "Wrong response from the webhook: 401 Unauthorized",
  };
  const r = await run(["--info"], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: fake.url }); // no secret/url needed for --info
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pending updates:\s+3/);
  assert.match(r.out, /last error:.*401 Unauthorized/);
  assert.doesNotMatch(r.out, /hunter2/);
  assert.doesNotMatch(r.out, /AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/);
  assert.match(r.out, /\(masked\)/);
});

test("--delete removes the webhook", async () => {
  fake.calls.length = 0;
  const r = await run(["--delete", "--drop-pending"], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: fake.url });
  assert.equal(r.code, 0, r.out);
  assert.equal(fake.calls.find((c) => c.method === "deleteWebhook")!.body.drop_pending_updates, true);
});

test("--dry-run validates the environment and makes NO network call", async () => {
  fake.calls.length = 0;
  const r = await run(["--dry-run"], goodEnv());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[dry-run\]/);
  assert.match(r.out, /secret_token:\s+\(set, hidden\)/);
  assert.equal(fake.calls.length, 0);
});

test("validation failures exit 2 with a helpful message and never echo values", async () => {
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ ...goodEnv(), TELEGRAM_BOT_TOKEN: undefined }, /TELEGRAM_BOT_TOKEN is not set/],
    [{ ...goodEnv(), TELEGRAM_BOT_TOKEN: "not-a-token-FAKE_SECRET_value" }, /does not look like a bot token/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_SECRET: undefined }, /TELEGRAM_WEBHOOK_SECRET is not set/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_SECRET: "short" }, /16-256 characters/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_SECRET: "has spaces and !!! chars 1234567890" }, /16-256 characters/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: undefined }, /TELEGRAM_WEBHOOK_URL is not set/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "http://dashboard.example.com/api/telegram/webhook" }, /must be https/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "https://dashboard.example.com/api/telegram/webhook/" }, /path must be exactly/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "https://dashboard.example.com/other" }, /path must be exactly/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "https://dashboard.example.com/api/telegram/webhook?secret=x" }, /query string/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "https://user:pw@dashboard.example.com/api/telegram/webhook" }, /credentials/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "https://localhost/api/telegram/webhook" }, /PUBLIC host/],
    [{ ...goodEnv(), TELEGRAM_WEBHOOK_URL: "not a url" }, /not a valid URL/],
  ];
  fake.calls.length = 0;
  for (const [env, re] of cases) {
    const r = await run([], env);
    assert.equal(r.code, 2, `${re}: ${r.out}`);
    assert.match(r.out, re);
  }
  assert.equal(fake.calls.length, 0, "validation must fail before any network call");
});

test("the token can never be redirected to a non-loopback host via TELEGRAM_API_BASE", async () => {
  const r = await run([], { ...goodEnv(), TELEGRAM_API_BASE: "https://evil.example.com" });
  assert.equal(r.code, 2);
  assert.match(r.out, /only honoured for http:\/\/127\.0\.0\.1/);
  assert.equal((await run([], { ...goodEnv(), TELEGRAM_API_BASE: "http://127.0.0.1.evil.com" })).code, 2);
});

test("unknown option is refused", async () => {
  const r = await run(["--secret=abc"], goodEnv());
  assert.equal(r.code, 2);
  assert.match(r.out, /Unknown option/);
});

test("Telegram rejecting the call => exit 1 with Telegram's description, no secrets", async () => {
  fake.failMethod("setWebhook", 401);
  const r = await run([], goodEnv());
  fake.failMethod("setWebhook", null);
  assert.equal(r.code, 1);
  assert.match(r.out, /HTTP 401 - Simulated failure of setWebhook/);
});

test("network failure => exit 1, generic message, no URL/token in output", async () => {
  const r = await run([], { ...goodEnv(), TELEGRAM_API_BASE: "http://127.0.0.1:1" }); // nothing listens on port 1
  assert.equal(r.code, 1);
  assert.match(r.out, /Network error calling setWebhook/);
});
