// Shared helpers for the REAL-infrastructure suites: the real Supabase project
// (service + anon keys from the environment - never printed) and a real
// `next start` server with the Telegram Bot API pointed at a local fake.
//
// Run with the env file loaded, e.g.:
//   node --env-file=.env.local --import tsx --test tests/integration/<file>.test.ts
//
// Everything created here is disposable and prefixed/ranged so cleanup() can
// find it: hwids/emails/campaign names start with TEST_TG_, Telegram user ids
// and update ids live at >= TEST_ID_BASE (real Telegram ids are far below it).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const TEST_PREFIX = "TEST_TG_";
export const TEST_ID_BASE = 9_100_000_000;

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set - run with: node --env-file=.env.local --import tsx --test <file>`);
  return v;
}

export const supabaseUrl = () => env("NEXT_PUBLIC_SUPABASE_URL");

let _svc: SupabaseClient | null = null;
export function svc(): SupabaseClient {
  return (_svc ??= createClient(supabaseUrl(), env("SUPABASE_SERVICE_KEY"), { auth: { persistSession: false } }));
}
let _anon: SupabaseClient | null = null;
export function anon(): SupabaseClient {
  return (_anon ??= createClient(supabaseUrl(), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } }));
}

let n = 0;
export const uniq = (p: string) => `${TEST_PREFIX}${p}_${Date.now().toString(36)}_${++n}_${crypto.randomBytes(3).toString("hex")}`;
let tg = TEST_ID_BASE + Math.floor(Math.random() * 1_000_000) * 100;
export const nextTgId = () => ++tg;
let up = TEST_ID_BASE + Math.floor(Math.random() * 1_000_000) * 100;
export const nextUpdateId = () => ++up;

// ── Row counts (proves cleanup left no residue) ─────────────────────────────

const TABLES = [
  "users", "licenses", "campaigns", "campaign_exports", "video_submissions", "admin_sessions",
  "telegram_users", "telegram_links", "telegram_link_codes", "telegram_updates",
  "telegram_rate_limits", "telegram_pending_choices", "telegram_duplicate_attempts",
];

export async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count, error } = await svc().from(t).select("*", { count: "exact", head: true });
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

// ── Disposable data ─────────────────────────────────────────────────────────

export async function mkUser(opts: { license?: "active" | "revoked" | null; emailPrefix?: string } = {}) {
  const hwid = uniq("hw");
  const { data, error } = await svc().from("users").insert({ email: `${opts.emailPrefix ?? ""}${hwid}@example.invalid`, hwid }).select("id").single();
  if (error) throw new Error(`mkUser: ${error.message}`);
  if (opts.license !== null) {
    const { error: lErr } = await svc().from("licenses").insert({ key: uniq("KEY"), hwid, status: opts.license ?? "active", plan_type: "free" });
    if (lErr) throw new Error(`mkUser license: ${lErr.message}`);
  }
  return { id: data.id as string, hwid };
}

export async function mkCampaign(name: string, status = "active") {
  const { data, error } = await svc().from("campaigns").insert({ name: `${TEST_PREFIX}${name}_${crypto.randomBytes(2).toString("hex")}`, status }).select("id, name").single();
  if (error) throw new Error(`mkCampaign: ${error.message}`);
  return { id: data.id as string, name: data.name as string };
}

export async function mkExport(hwid: string, campaignId: string, hoursAgo = 1) {
  const { error } = await svc().from("campaign_exports").insert({ campaign_id: campaignId, hwid, exported_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString() });
  if (error) throw new Error(`mkExport: ${error.message}`);
}

/** Delete EVERYTHING these tests created. Safe to call repeatedly. */
export async function cleanup(): Promise<void> {
  const db = svc();
  const del = async (label: string, p: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await p;
    if (error) throw new Error(`cleanup ${label}: ${error.message}`);
  };
  // users first: cascades to video_submissions, telegram_link_codes, (dup attempts via submissions)
  await del("users", db.from("users").delete().like("hwid", `${TEST_PREFIX}%`));
  await del("licenses", db.from("licenses").delete().like("hwid", `${TEST_PREFIX}%`));
  await del("licenses(key)", db.from("licenses").delete().like("key", `${TEST_PREFIX}%`));
  await del("telegram_links", db.from("telegram_links").delete().like("hwid", `${TEST_PREFIX}%`));
  await del("telegram_links(id)", db.from("telegram_links").delete().gte("telegram_user_id", TEST_ID_BASE));
  await del("telegram_link_codes", db.from("telegram_link_codes").delete().like("hwid", `${TEST_PREFIX}%`));
  await del("telegram_dup", db.from("telegram_duplicate_attempts").delete().gte("telegram_user_id", TEST_ID_BASE));
  await del("telegram_users", db.from("telegram_users").delete().gte("telegram_user_id", TEST_ID_BASE));
  await del("telegram_updates", db.from("telegram_updates").delete().gte("update_id", TEST_ID_BASE));
  await del("telegram_pending_choices", db.from("telegram_pending_choices").delete().gte("telegram_user_id", TEST_ID_BASE));
  // Rate-limit keys look like msg:<id>, urls:day:<id>, urls:win:<id>, linkatt:<id>. Delete EXACTLY the ones whose
  // trailing Telegram id is in the test range (a string-prefix LIKE could touch a real user's counters).
  {
    const { data, error } = await db.from("telegram_rate_limits").select("key").limit(20000);
    if (error) throw new Error(`cleanup telegram_rate_limits(select): ${error.message}`);
    const mine = (data ?? []).map((r) => r.key as string).filter((k) => {
      const m = /^(?:msg|urls:day|urls:win|linkatt):(\d+)$/.exec(k);
      return (m !== null && Number(m[1]) >= TEST_ID_BASE) || k.startsWith(TEST_PREFIX);
    });
    for (let i = 0; i < mine.length; i += 100) {
      await del("telegram_rate_limits", db.from("telegram_rate_limits").delete().in("key", mine.slice(i, i + 100)));
    }
  }
  // The global /link attempt bucket is a rolling counter the /link tests touch; resetting it is harmless.
  await del("telegram_rate_limits(global)", db.from("telegram_rate_limits").delete().eq("key", "linkatt:global"));
  await del("campaign_exports", db.from("campaign_exports").delete().like("hwid", `${TEST_PREFIX}%`));
  await del("campaigns", db.from("campaigns").delete().like("name", `${TEST_PREFIX}%`));
  await del("admin_sessions", db.from("admin_sessions").delete().like("id", `${TEST_PREFIX}%`));
}

export async function mkAdminSession(): Promise<string> {
  const token = `${TEST_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const { error } = await svc().from("admin_sessions").insert({ id: token, data: {}, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (error) throw new Error(`mkAdminSession: ${error.message}`);
  return token;
}

// ── Timing ──────────────────────────────────────────────────────────────────

export function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, min: s[0] ?? 0, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? 0, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0 };
}
export const fmt = (x: { n: number; min: number; p50: number; p95: number; max: number }) =>
  `n=${x.n} min=${x.min.toFixed(0)}ms p50=${x.p50.toFixed(0)}ms p95=${x.p95.toFixed(0)}ms max=${x.max.toFixed(0)}ms`;

// ── A real `next start` server ──────────────────────────────────────────────

export interface App {
  base: string;
  logs(): string;
  stop(): Promise<void>;
}

export async function startApp(port: number, extraEnv: Record<string, string>): Promise<App> {
  const nextBin = path.resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(path.resolve(process.cwd(), ".next", "BUILD_ID"))) throw new Error("No production build - run `npx next build` first.");
  let out = "";
  const child: ChildProcess = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    env: { ...process.env, ...extraEnv, PORT: String(port), NODE_ENV: "production" } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${out}`);
    try {
      const r = await fetch(`${base}/login`, { redirect: "manual" });
      if (r.status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`next start did not become ready:\n${out}`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    base,
    logs: () => out,
    stop: async () => {
      if (child.pid && process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

export async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  return { status: r.status, text: await r.text(), ms: performance.now() - t0 };
}

/** POST that tolerates the server refusing an oversized upload by closing the socket while the
 * client is still writing (an early 413 + connection close is correct server behaviour; undici
 * surfaces it as "fetch failed"). Returns the status, or "refused" if the connection was dropped. */
export async function postOversized(url: string, body: string, headers: Record<string, string> = {}): Promise<number | "refused"> {
  try {
    return (await post(url, body, headers)).status;
  } catch {
    return "refused";
  }
}
