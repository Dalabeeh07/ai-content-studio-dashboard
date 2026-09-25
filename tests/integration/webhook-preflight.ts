// Webhook smoke that needs NO database tables (safe to run before OR after the
// migration): authentication, size cap, shape filtering, routing, and "no
// secret in the logs" against a real `next start` server with a fake Telegram.
//   node --env-file=.env.local --import tsx tests/integration/webhook-preflight.ts
// (Before migration 041 is applied, a structurally valid update answers 503 -
// the designed "Telegram will redeliver" response - which is not asserted here.)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startFakeTelegram } from "../helpers/fakeTelegram";
import { post, postOversized, startApp } from "./helpers";

async function main() {
  const SECRET = `TEST_TG_${crypto.randomBytes(16).toString("hex")}`;
  const TOKEN = `987654321:TEST_TG_FAKE_${crypto.randomBytes(10).toString("hex")}`;
  const fake = await startFakeTelegram();
  const app = await startApp(3100, { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: fake.url });
  const url = `${app.base}/api/telegram/webhook`;
  const good = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
  const u = (extra = {}) => ({ update_id: 9_100_000_001, message: { message_id: 1, from: { id: 9_100_000_001 }, chat: { id: 9_100_000_001, type: "private" }, text: "/start", ...extra } });
  const out: [string, number | string][] = [];
  const rec = async (label: string, p: Promise<{ status: number }>, want: number) => { const r = await p; out.push([label, r.status]); assert.equal(r.status, want, label); };

  await rec("no secret header", post(url, u()), 401);
  await rec("wrong secret", post(url, u(), { "X-Telegram-Bot-Api-Secret-Token": "nope" }), 401);
  await rec("empty secret", post(url, u(), { "X-Telegram-Bot-Api-Secret-Token": "" }), 401);
  await rec("secret differing in last char", post(url, u(), { "X-Telegram-Bot-Api-Secret-Token": SECRET.slice(0, -1) + (SECRET.endsWith("0") ? "1" : "0") }), 401);
  const big = JSON.stringify({ update_id: 1, message: { text: "x".repeat(200_000) } });
  const o1 = await postOversized(url, big, good); out.push(["valid secret, oversized body", o1]); assert.ok(o1 === 413 || o1 === "refused", String(o1));
  const o2 = await postOversized(url, big, { ...good, "Content-Length": "5" }); out.push(["valid secret, lying content-length", o2]); assert.ok(o2 === 413 || o2 === "refused" || o2 === 200 || o2 === 400, String(o2));
  await rec("valid secret, malformed JSON", post(url, "{oops", good), 200);
  await rec("valid secret, empty body", post(url, "", good), 200);
  await rec("valid secret, group chat", post(url, { update_id: 9_100_000_002, message: { message_id: 1, from: { id: 9_100_000_001 }, chat: { id: -100, type: "supergroup" }, text: "/start" } }, good), 200);
  await rec("valid secret, edited_message", post(url, { update_id: 9_100_000_003, edited_message: u().message }, good), 200);
  await rec("valid secret, channel_post", post(url, { update_id: 9_100_000_004, channel_post: u().message }, good), 200);
  const g = await fetch(url, { headers: good, redirect: "manual" }); out.push(["GET", g.status]); assert.equal(g.status, 405);
  const sib = await post(`${app.base}/api/telegram/webhook/x`, u(), good); out.push(["sibling path (not public)", sib.status]); assert.ok([307, 308, 404].includes(sib.status));
  const admin = await fetch(`${app.base}/submissions`, { redirect: "manual" }); out.push(["/submissions logged out", admin.status]); assert.equal(admin.status, 307);
  const exp = await fetch(`${app.base}/api/submissions/export`, { redirect: "manual" }); out.push(["export logged out", exp.status]); assert.ok([307, 401].includes(exp.status));
  assert.equal(fake.calls.length, 0, "no Bot API call may happen for any of the above");
  const logs = app.logs();
  assert.ok(!logs.includes(SECRET) && !logs.includes(TOKEN) && !logs.includes(TOKEN.split(":")[1]), "secret/token in server logs");
  await app.stop(); await fake.close();
  for (const [l, s] of out) console.log(String(s).padStart(4), l);
  console.log("PREFLIGHT OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
