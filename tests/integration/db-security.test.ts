// REAL Supabase project. Proves, with real HTTP probes (never `{}` PATCH bodies -
// PostgREST answers those 204 without touching anything, which proves nothing):
//   * every new table and every tg_* RPC is closed to the anon key,
//   * video_submissions stays write-closed and its NEW columns stay unreadable
//     (and never appear in the Realtime payload),
//   * the desktop app's submit_video_link path still works, unchanged,
//   * the service-role flow works, and the schema constraints are live.
// All data is disposable (TEST_TG_ prefix / id range) and cleaned up afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { anon, cleanup, env, mkUser, nextTgId, nextUpdateId, supabaseUrl, svc, tableCounts, uniq } from "./helpers";

const REST = () => `${supabaseUrl()}/rest/v1`;
let baseline: Record<string, number>;

async function raw(role: "anon" | "service", method: string, pathAndQuery: string, body?: unknown) {
  const key = role === "anon" ? env("NEXT_PUBLIC_SUPABASE_ANON_KEY") : env("SUPABASE_SERVICE_KEY");
  const r = await fetch(`${REST()}/${pathAndQuery}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: { code?: string } = {};
  try { json = JSON.parse(text); } catch { /* 204 / empty */ }
  return { status: r.status, code: json.code, text };
}

before(async () => { await cleanup(); baseline = await tableCounts(); });
after(async () => {
  await cleanup();
  const after = await tableCounts();
  assert.deepEqual(after, baseline, "test data must leave every table exactly as it was");
});

const NEW_TABLES: Record<string, Record<string, unknown>> = {
  telegram_users: { telegram_user_id: 9_999_999_001, username: "x" },
  telegram_links: { telegram_user_id: 9_999_999_001, hwid: "TEST_TG_probe" },
  telegram_link_codes: { code_hash: "TEST_TG_probe", hwid: "TEST_TG_probe", expires_at: "2099-01-01T00:00:00Z" },
  telegram_updates: { update_id: 9_999_999_001 },
  telegram_rate_limits: { key: "TEST_TG_probe", count: 1 },
  telegram_pending_choices: { token: "TEST_TG_probe", kind: "unlink", telegram_user_id: 1, chat_id: 1, expires_at: "2099-01-01T00:00:00Z" },
  telegram_duplicate_attempts: { submission_id: "00000000-0000-0000-0000-000000000000", telegram_user_id: 1, update_id: 1, raw_url: "x" },
};

test("anon key is DENIED (401/42501) on every new table for SELECT, INSERT, PATCH and DELETE (real bodies)", async () => {
  for (const [table, row] of Object.entries(NEW_TABLES)) {
    const col = Object.keys(row)[0];
    const results = {
      select: await raw("anon", "GET", `${table}?select=*&limit=1`),
      insert: await raw("anon", "POST", table, row),
      patch: await raw("anon", "PATCH", `${table}?${col}=eq.does-not-exist`, { [col]: row[col] }),
      delete: await raw("anon", "DELETE", `${table}?${col}=eq.does-not-exist`),
    };
    for (const [op, r] of Object.entries(results)) {
      assert.equal(r.status, 401, `${table} ${op}: expected 401, got ${r.status} ${r.text.slice(0, 120)}`);
      assert.equal(r.code, "42501", `${table} ${op}: expected 42501, got ${r.code}`);
    }
  }
  // ...and nothing was written by any of those attempts.
  const { count } = await svc().from("telegram_rate_limits").select("*", { count: "exact", head: true }).eq("key", "TEST_TG_probe");
  assert.equal(count, 0);
});

test("service role CAN read every new table (the bot's own access path works)", async () => {
  for (const table of Object.keys(NEW_TABLES)) {
    const r = await raw("service", "GET", `${table}?select=*&limit=1`);
    assert.equal(r.status, 200, `${table}: ${r.text.slice(0, 160)}`);
  }
});

const RPCS: Record<string, Record<string, unknown>> = {
  tg_claim_update: { p_update_id: 9_999_999_002 },
  tg_finish_update: { p_update_id: 9_999_999_002, p_status: "done" },
  tg_rate_consume: { p_key: "TEST_TG_anon_probe", p_window_seconds: 60, p_limit: 5, p_want: 1 },
  tg_rate_refund: { p_key: "TEST_TG_anon_probe", p_n: 1 },
  tg_get_context: { p_telegram_user_id: 9_999_999_003 },
  tg_set_language: { p_telegram_user_id: 9_999_999_003, p_username: "x", p_language: "en" },
  tg_create_link_code: { p_hwid: "TEST_TG_anon_probe", p_user_id: null, p_code_hash: "TEST_TG_anon_probe", p_ttl_seconds: 60 },
  tg_redeem_link_code: { p_code_hash: "TEST_TG_anon_probe", p_telegram_user_id: 9_999_999_003, p_username: "x", p_language: "ar" },
  tg_submit_links: { p_telegram_user_id: 9_999_999_003, p_update_id: 1, p_campaign_id: null, p_items: [] },
  tg_apply_campaign_choice: { p_token: "TEST_TG_anon_probe", p_telegram_user_id: 1, p_chat_id: 1, p_index: 0 },
  tg_consume_choice: { p_token: "TEST_TG_anon_probe", p_kind: "unlink", p_telegram_user_id: 1, p_chat_id: 1 },
  tg_recent_campaigns: { p_hwid: "TEST_TG_anon_probe", p_since: "2020-01-01T00:00:00Z", p_limit: 3 },
  tg_pending_counts: {},
  tg_cleanup: { p_updates_days: 3, p_rate_days: 2, p_choices_days: 1, p_codes_days: 30, p_links_days: 90 },
  tg_create_choice: { p_token: "TEST_TG_anon_probe", p_kind: "unlink", p_telegram_user_id: 1, p_chat_id: 1, p_payload: {}, p_ttl_seconds: 60 },
  tg_unlink: { p_telegram_user_id: 9_999_999_003 },
  tg_revoke_link_admin: { p_hwid: "TEST_TG_anon_probe" },
  tg_my_links: { p_hwid: "TEST_TG_anon_probe", p_limit: 5 },
  tg_today_count: { p_telegram_user_id: 9_999_999_003 },
};

test("anon key is DENIED on every one of the tg_* RPCs, and none of them executed", async () => {
  assert.equal(Object.keys(RPCS).length, 19);
  for (const [fn, args] of Object.entries(RPCS)) {
    const r = await raw("anon", "POST", `rpc/${fn}`, args);
    assert.equal(r.status, 401, `${fn}: expected 401, got ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(r.code, "42501", `${fn}: expected 42501, got ${r.code}`);
  }
  // Side-effect check: had any executed, these rows/keys would exist.
  const { count: rl } = await svc().from("telegram_rate_limits").select("*", { count: "exact", head: true }).eq("key", "TEST_TG_anon_probe");
  const { count: cd } = await svc().from("telegram_link_codes").select("*", { count: "exact", head: true }).eq("code_hash", "TEST_TG_anon_probe");
  const { count: tu } = await svc().from("telegram_users").select("*", { count: "exact", head: true }).eq("telegram_user_id", 9_999_999_003);
  assert.deepEqual([rl, cd, tu], [0, 0, 0]);
});

test("service role can call the RPCs (grants are service_role-only, not broken)", async () => {
  const key = uniq("rl");
  const { data, error } = await svc().rpc("tg_rate_consume", { p_key: key, p_window_seconds: 60, p_limit: 2, p_want: 5 });
  assert.equal(error, null);
  assert.deepEqual((data as { granted: number }[])[0].granted, 2);
  await svc().from("telegram_rate_limits").delete().eq("key", key);
  const claim = await svc().rpc("tg_claim_update", { p_update_id: nextUpdateId(), p_stale_seconds: 60, p_max_attempts: 3 });
  assert.equal(claim.data, "new");
});

test("video_submissions: anon reads ONLY the 024 columns, can write nothing, new columns hidden", async () => {
  const ok = await raw("anon", "GET", "video_submissions?select=id,hardware_id,platform,video_url,username,status,submitted_at,whop_confirmed&limit=1");
  assert.equal(ok.status, 200, ok.text.slice(0, 160));
  for (const col of ["user_id", "updated_at", "source", "telegram_user_id", "telegram_update_id", "campaign_id", "canonical_url", "whop_submitted_at", "flags"]) {
    const r = await raw("anon", "GET", `video_submissions?select=${col}&limit=1`);
    assert.equal(r.status, 401, `column ${col} readable by anon! ${r.text.slice(0, 120)}`);
  }
  const ZERO = "00000000-0000-0000-0000-000000000000";
  assert.equal((await raw("anon", "PATCH", `video_submissions?id=eq.${ZERO}`, { status: "verified" })).status, 401);
  assert.equal((await raw("anon", "PATCH", `video_submissions?id=eq.${ZERO}`, { whop_submitted_at: "2026-01-01T00:00:00Z" })).status, 401);
  assert.equal((await raw("anon", "PATCH", `video_submissions?id=eq.${ZERO}`, { flags: ["x"] })).status, 401);
  assert.equal((await raw("anon", "DELETE", `video_submissions?id=eq.${ZERO}`)).status, 401);
  assert.equal((await raw("anon", "POST", "video_submissions", { user_id: ZERO, hardware_id: "x", platform: "x", video_url: "u", username: "u" })).status, 401);
  assert.equal((await raw("anon", "POST", "video_submissions", { user_id: ZERO, hardware_id: "x", platform: "tiktok", video_url: "u", username: "u", source: "telegram" })).status, 401);
});

test("DESKTOP PATH UNCHANGED: anon submit_video_link still works, writes an 'app' row, no dedupe, still 3 platforms", async () => {
  const u = await mkUser();
  const call = (platform: string, url: string) => raw("anon", "POST", "rpc/submit_video_link", { p_hwid: u.hwid, p_platform: platform, p_video_url: url, p_username: `${u.hwid}_creator` });
  const url = `https://www.tiktok.com/@creator/video/${Date.now()}`;
  const a = await call("tiktok", url);
  const b = await call("tiktok", url); // desktop RPC has never de-duplicated; must be unchanged
  assert.equal(a.status, 200, a.text); assert.equal(b.status, 200, b.text);
  assert.equal(JSON.parse(a.text).ok, true);
  assert.equal(JSON.parse(b.text).ok, true);
  const { data } = await svc().from("video_submissions").select("source, canonical_url, telegram_user_id, campaign_id, whop_submitted_at, flags, status, platform").eq("hardware_id", u.hwid);
  assert.equal(data?.length, 2);
  for (const row of data ?? []) {
    assert.deepEqual(row, { source: "app", canonical_url: null, telegram_user_id: null, campaign_id: null, whop_submitted_at: null, flags: [], status: "pending_review", platform: "tiktok" });
  }
  const x = await call("x", "https://x.com/i/status/1");
  assert.equal(JSON.parse(x.text).reason, "invalid_platform");
  const missing = await raw("anon", "POST", "rpc/submit_video_link", { p_hwid: uniq("nobody"), p_platform: "tiktok", p_video_url: "https://a", p_username: "u" });
  assert.equal(JSON.parse(missing.text).reason, "user_not_found");
});

test("live constraints: platform 'x' allowed, junk platform refused, canonical_url globally unique, one active link per hwid/telegram account", async () => {
  const u = await mkUser();
  const base = { user_id: u.id, hardware_id: u.hwid, username: "u", video_url: "https://x.com/i/status/5" };
  const canon = `https://x.com/i/status/${uniq("c")}`;
  const ok = await svc().from("video_submissions").insert({ ...base, platform: "x", source: "telegram", canonical_url: canon });
  assert.equal(ok.error, null, ok.error?.message);
  const dup = await svc().from("video_submissions").insert({ ...base, platform: "x", source: "telegram", canonical_url: canon });
  assert.equal(dup.error?.code, "23505", "canonical_url must be globally unique");
  const bad = await svc().from("video_submissions").insert({ ...base, platform: "facebook" });
  assert.equal(bad.error?.code, "23514", "platform CHECK must reject unknown platforms");
  const badSource = await svc().from("video_submissions").insert({ ...base, platform: "x", source: "carrier-pigeon" });
  assert.equal(badSource.error?.code, "23514");
  const nulls = await svc().from("video_submissions").insert([{ ...base, platform: "x" }, { ...base, platform: "x" }]);
  assert.equal(nulls.error, null, "rows without a canonical_url (desktop) must not collide");

  const t = nextTgId();
  await svc().from("telegram_users").insert({ telegram_user_id: t, language: "ar" });
  const l1 = await svc().from("telegram_links").insert({ telegram_user_id: t, hwid: u.hwid, user_id: u.id });
  assert.equal(l1.error, null, l1.error?.message);
  const t2 = nextTgId();
  await svc().from("telegram_users").insert({ telegram_user_id: t2 });
  const sameHwid = await svc().from("telegram_links").insert({ telegram_user_id: t2, hwid: u.hwid });
  assert.equal(sameHwid.error?.code, "23505", "second ACTIVE link for one hwid must be refused");
  const sameTg = await svc().from("telegram_links").insert({ telegram_user_id: t, hwid: uniq("other") });
  assert.equal(sameTg.error?.code, "23505", "second ACTIVE link for one telegram account must be refused");
});

test("Realtime: video_submissions is published, and a Telegram-shaped INSERT reaches anon WITHOUT the new columns", async () => {
  const u = await mkUser();
  const GRANTED = ["id", "hardware_id", "platform", "video_url", "username", "status", "submitted_at", "whop_confirmed"];
  const client = anon();
  const received = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no Realtime INSERT event within 15s - is video_submissions in the supabase_realtime publication?")), 15000);
    client
      .channel(`tg-test-${Date.now()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "video_submissions", select: GRANTED } as never, (p: { new: Record<string, unknown> }) => {
        if (String(p.new.hardware_id) === u.hwid) { clearTimeout(timer); resolve(p.new); }
      })
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          void svc().from("video_submissions").insert({
            user_id: u.id, hardware_id: u.hwid, platform: "tiktok", video_url: "https://www.tiktok.com/@t/video/1", username: "u",
            source: "telegram", telegram_user_id: nextTgId(), canonical_url: `https://www.tiktok.com/@/video/${uniq("rt")}`, flags: ["short_link"],
          });
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(new Error(`realtime channel ${status}`)); }
      });
  });
  const payload = await received;
  await client.removeAllChannels();
  for (const k of Object.keys(payload)) assert.ok(GRANTED.includes(k), `Realtime leaked column ${k}`);
  for (const hidden of ["telegram_user_id", "canonical_url", "flags", "campaign_id", "source", "user_id", "whop_submitted_at"]) {
    assert.ok(!(hidden in payload), `Realtime payload contains ${hidden}`);
  }
});
