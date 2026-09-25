import { test, before } from "node:test";
import assert from "node:assert/strict";
import { make041, makePre041, readMigration, asRole, expectDenied, type Db } from "./harness";

let db: Db;
const MIG = readMigration("041_telegram_link_intake.sql");

let seq = 0;
const uniq = (p: string) => `${p}_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

async function mkUser(hwid = uniq("hwid")) {
  const r = await db.query<{ id: string }>(`INSERT INTO users (email, hwid) VALUES ($1, $2) RETURNING id`, [`${hwid}@example.invalid`, hwid]);
  return { id: r.rows[0].id, hwid };
}
async function mkLicense(hwid: string, status = "active", expires: string | null = null) {
  await db.query(`INSERT INTO licenses (key, hwid, status, expires_at) VALUES ($1, $2, $3, $4)`, [uniq("KEY"), hwid, status, expires]);
}
async function code(hwid: string, userId: string, hash = uniq("hash"), ttl = 3600) {
  await db.query(`SELECT tg_create_link_code($1, $2, $3, $4)`, [hwid, userId, hash, ttl]);
  return hash;
}
async function redeem(hash: string, tgId: number, username: string | null = "someone", lang = "ar") {
  const r = await db.query<{ tg_redeem_link_code: Record<string, unknown> }>(`SELECT tg_redeem_link_code($1, $2, $3, $4)`, [hash, tgId, username, lang]);
  return r.rows[0].tg_redeem_link_code;
}
async function linked(tgId: number) {
  const u = await mkUser();
  await mkLicense(u.hwid);
  const h = await code(u.hwid, u.id);
  const r = await redeem(h, tgId);
  assert.equal(r.ok, true);
  return u;
}
const item = (n: string, over: Record<string, unknown> = {}) => ({
  video_url: `https://www.tiktok.com/@u/video/${n}`,
  canonical_url: `https://www.tiktok.com/@/video/${n}`,
  platform: "tiktok", username: "u", opaque: false, ...over,
});
async function submit(tgId: number, updateId: number, items: unknown[], campaign: string | null = null) {
  const r = await db.query<{ tg_submit_links: { ok: boolean; reason?: string; results: { outcome: string; id: string; canonical_url: string }[]; today_count: number; license_active: boolean } }>(
    `SELECT tg_submit_links($1, $2, $3, $4::jsonb)`, [tgId, updateId, campaign, JSON.stringify(items)]);
  return r.rows[0].tg_submit_links;
}
let tg = 1_000_000;
const nextTg = () => ++tg;
let upd = 5_000_000;
const nextUpd = () => ++upd;

before(async () => {
  db = await make041();
});

// ── Migration itself ─────────────────────────────────────────────────────────

test("migration re-applies cleanly (idempotent) and PART 4 safety block is real", async () => {
  await db.exec(MIG);

  // The safety block must actually be capable of failing. Take the PART 4
  // block on its own and prove each class of drift trips it.
  const part4 = MIG.slice(MIG.indexOf("-- PART 4: safety check"));
  const block = part4.slice(part4.indexOf("DO $$"), part4.indexOf("NOTIFY pgrst"));
  await db.exec(block); // clean state passes

  const drifts: [string, string, string][] = [
    ["anon reads a new table", "GRANT SELECT ON public.telegram_links TO anon", "REVOKE SELECT ON public.telegram_links FROM anon"],
    ["authenticated writes a new table", "GRANT INSERT ON public.telegram_updates TO authenticated", "REVOKE INSERT ON public.telegram_updates FROM authenticated"],
    ["anon can execute an RPC", "GRANT EXECUTE ON FUNCTION public.tg_pending_counts() TO anon", "REVOKE EXECUTE ON FUNCTION public.tg_pending_counts() FROM anon"],
    ["service_role loses a table", "REVOKE SELECT ON public.telegram_users FROM service_role", "GRANT ALL ON public.telegram_users TO service_role"],
    ["anon can write video_submissions", "GRANT UPDATE (status) ON public.video_submissions TO anon", "REVOKE UPDATE (status) ON public.video_submissions FROM anon"],
    ["anon can read a new column", "GRANT SELECT (canonical_url) ON public.video_submissions TO anon", "REVOKE SELECT (canonical_url) ON public.video_submissions FROM anon"],
    ["RLS disabled", "ALTER TABLE public.telegram_rate_limits DISABLE ROW LEVEL SECURITY", "ALTER TABLE public.telegram_rate_limits ENABLE ROW LEVEL SECURITY"],
  ];
  for (const [label, breakIt, fixIt] of drifts) {
    await db.exec(breakIt);
    await assert.rejects(() => db.exec(block), Error, `safety check should have failed for: ${label}`);
    await db.exec(fixIt);
  }
  await db.exec(block); // back to clean
});

test("platform CHECK now accepts 'x' and still rejects garbage", async () => {
  const u = await mkUser();
  await db.query(`INSERT INTO video_submissions (user_id, hardware_id, platform, video_url, username) VALUES ($1,$2,'x','https://x.com/i/status/1','u')`, [u.id, u.hwid]);
  await assert.rejects(() => db.query(`INSERT INTO video_submissions (user_id, hardware_id, platform, video_url, username) VALUES ($1,$2,'facebook','https://f','u')`, [u.id, u.hwid]));
});

test("desktop path untouched: anon can still call submit_video_link (old 3 platforms), new columns default correctly", async () => {
  const u = await mkUser();
  const r = await asRole<{ submit_video_link: { ok: boolean; id: string } }>(db, "anon", `SELECT submit_video_link($1,'tiktok','https://www.tiktok.com/@a/video/123','somebody')`, [u.hwid]);
  assert.equal(r.rows[0].submit_video_link.ok, true);
  const row = await db.query<Record<string, unknown>>(`SELECT source, canonical_url, telegram_user_id, campaign_id, whop_submitted_at, flags FROM video_submissions WHERE id = $1`, [r.rows[0].submit_video_link.id]);
  assert.deepEqual(row.rows[0], { source: "app", canonical_url: null, telegram_user_id: null, campaign_id: null, whop_submitted_at: null, flags: [] });
  // The old RPC still rejects the new platform (intentionally unchanged).
  const x = await asRole<{ submit_video_link: { ok: boolean; reason: string } }>(db, "anon", `SELECT submit_video_link($1,'x','https://x.com/i/status/1','somebody')`, [u.hwid]);
  assert.equal(x.rows[0].submit_video_link.ok, false);
  assert.equal(x.rows[0].submit_video_link.reason, "invalid_platform");
});

test("two desktop rows with NULL canonical_url do not collide on the unique index", async () => {
  const u = await mkUser();
  for (let i = 0; i < 3; i++) await asRole(db, "anon", `SELECT submit_video_link($1,'youtube','https://youtu.be/same','somebody')`, [u.hwid]);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM video_submissions WHERE hardware_id = $1`, [u.hwid]);
  assert.equal(n.rows[0].n, 3);
});

// ── Privileges ───────────────────────────────────────────────────────────────

test("anon and authenticated are denied on every new table and every tg_* function", async () => {
  const tables = ["telegram_users", "telegram_links", "telegram_link_codes", "telegram_updates", "telegram_rate_limits", "telegram_pending_choices", "telegram_duplicate_attempts"];
  for (const t of tables) {
    for (const role of ["anon", "authenticated"] as const) {
      await expectDenied(db, role, `SELECT * FROM public.${t} LIMIT 1`);
      await expectDenied(db, role, `DELETE FROM public.${t}`);
    }
  }
  const fns: [string, string][] = [
    ["tg_claim_update", "SELECT tg_claim_update(1)"],
    ["tg_finish_update", "SELECT tg_finish_update(1,'done')"],
    ["tg_rate_consume", "SELECT * FROM tg_rate_consume('k',60,1,1)"],
    ["tg_rate_refund", "SELECT tg_rate_refund('k',1)"],
    ["tg_get_context", "SELECT tg_get_context(1)"],
    ["tg_set_language", "SELECT tg_set_language(1,'u','ar')"],
    ["tg_create_link_code", "SELECT tg_create_link_code('h', NULL, 'x', 60)"],
    ["tg_redeem_link_code", "SELECT tg_redeem_link_code('x', 1, 'u', 'ar')"],
    ["tg_submit_links", "SELECT tg_submit_links(1, 1, NULL, '[]'::jsonb)"],
    ["tg_apply_campaign_choice", "SELECT tg_apply_campaign_choice('t', 1, 1, 0)"],
    ["tg_consume_choice", "SELECT tg_consume_choice('t','unlink',1,1)"],
    ["tg_recent_campaigns", "SELECT * FROM tg_recent_campaigns('h', now())"],
    ["tg_pending_counts", "SELECT * FROM tg_pending_counts()"],
    ["tg_cleanup", "SELECT tg_cleanup()"],
    ["tg_create_choice", "SELECT tg_create_choice('t','unlink',1,1,'{}'::jsonb,60)"],
    ["tg_unlink", "SELECT tg_unlink(1)"],
    ["tg_revoke_link_admin", "SELECT tg_revoke_link_admin('h')"],
    ["tg_my_links", "SELECT * FROM tg_my_links('h')"],
    ["tg_today_count", "SELECT tg_today_count(1)"],
  ];
  for (const [, sql] of fns) {
    for (const role of ["anon", "authenticated"] as const) await expectDenied(db, role, sql);
  }
  // service_role can run them.
  await asRole(db, "service_role", "SELECT * FROM tg_pending_counts()");
});

test("anon cannot read the new video_submissions columns but still reads the 024 set", async () => {
  await asRole(db, "anon", "SELECT id, hardware_id, platform, video_url, username, status, submitted_at, whop_confirmed FROM video_submissions LIMIT 1");
  for (const col of ["user_id", "telegram_user_id", "campaign_id", "canonical_url", "flags", "source", "whop_submitted_at"]) {
    await expectDenied(db, "anon", `SELECT ${col} FROM video_submissions LIMIT 1`);
  }
  await expectDenied(db, "anon", "UPDATE video_submissions SET status = 'verified' WHERE id = gen_random_uuid()");
  await expectDenied(db, "anon", "DELETE FROM video_submissions WHERE id = gen_random_uuid()");
});

// ── tg_claim_update ─────────────────────────────────────────────────────────

test("claim_update: new -> duplicate; stale unfinished -> retry (bounded); finished stays duplicate", async () => {
  const id = nextUpd();
  // stale = -1 means "always stale": PGlite's clock is coarse (two statements can share a
  // timestamp), and a real Postgres has microsecond resolution so this only affects the test.
  const claim = async (stale = 60, max = 3) => (await db.query<{ tg_claim_update: string }>(`SELECT tg_claim_update($1,$2,$3)`, [id, stale, max])).rows[0].tg_claim_update;
  assert.equal(await claim(), "new");
  assert.equal(await claim(), "duplicate");            // in flight, not stale yet
  assert.equal(await claim(-1), "retry");               // stale (attempt 2)
  assert.equal(await claim(-1), "retry");               // attempt 3
  assert.equal(await claim(-1), "duplicate");           // attempts exhausted (max 3)
  const id2 = nextUpd();
  await db.query(`SELECT tg_claim_update($1)`, [id2]);
  await db.query(`SELECT tg_finish_update($1,'done')`, [id2]);
  const again = await db.query<{ tg_claim_update: string }>(`SELECT tg_claim_update($1, -1, 3)`, [id2]);
  assert.equal(again.rows[0].tg_claim_update, "duplicate"); // done is terminal even if "stale"
  await assert.rejects(() => db.query(`SELECT tg_finish_update($1,'bogus')`, [id2]));
});

// ── tg_rate_consume / refund ────────────────────────────────────────────────

test("rate_consume: partial grants, exhaustion, peek, refund, window reset", async () => {
  const key = uniq("rl");
  const c = async (want: number, limit = 5, win = 600) =>
    (await db.query<{ granted: number; remaining: number; retry_after_seconds: number }>(`SELECT * FROM tg_rate_consume($1,$2,$3,$4)`, [key, win, limit, want])).rows[0];
  assert.deepEqual(await c(3), { granted: 3, remaining: 2, retry_after_seconds: (await c(0)).retry_after_seconds });
  const g2 = await c(4);
  assert.equal(g2.granted, 2); assert.equal(g2.remaining, 0);
  const g3 = await c(1);
  assert.equal(g3.granted, 0);
  assert.ok(g3.retry_after_seconds > 0 && g3.retry_after_seconds <= 600);
  assert.equal((await c(0)).granted, 0); // peek
  await db.query(`SELECT tg_rate_refund($1, 2)`, [key]);
  assert.equal((await c(5)).granted, 2);
  await db.query(`SELECT tg_rate_refund($1, 999)`, [key]); // floor at zero
  assert.equal((await c(5)).granted, 5);
  // window expiry
  await db.query(`UPDATE telegram_rate_limits SET window_start = now() - interval '11 minutes' WHERE key = $1`, [key]);
  assert.equal((await c(5)).granted, 5);
  // negative / null want never grants or corrupts
  assert.equal((await c(-3)).granted, 0);
});

// ── Link codes ───────────────────────────────────────────────────────────────

test("link code: redeem succeeds once; reuse, wrong code, expired, revoked all -> invalid_code with a private detail", async () => {
  const u = await mkUser();
  const h = await code(u.hwid, u.id);
  const t1 = nextTg();
  const ok = await redeem(h, t1);
  assert.equal(ok.ok, true);
  assert.equal(ok.hwid, u.hwid);
  assert.equal(ok.replaced_previous, false);

  const t2 = nextTg();
  const reuse = await redeem(h, t2);
  assert.deepEqual([reuse.ok, reuse.reason, reuse.detail], [false, "invalid_code", "used"]);

  const bogus = await redeem("no_such_hash", nextTg());
  assert.deepEqual([bogus.ok, bogus.reason, bogus.detail], [false, "invalid_code", "unknown"]);

  const u2 = await mkUser();
  const hExp = await code(u2.hwid, u2.id, uniq("h"), 1);
  await db.query(`UPDATE telegram_link_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [hExp]);
  const exp = await redeem(hExp, nextTg());
  assert.deepEqual([exp.reason, exp.detail], ["invalid_code", "expired"]);

  const u3 = await mkUser();
  const hRev = await code(u3.hwid, u3.id);
  await db.query(`UPDATE telegram_link_codes SET revoked_at = now() WHERE code_hash = $1`, [hRev]);
  const rev = await redeem(hRev, nextTg());
  assert.deepEqual([rev.reason, rev.detail], ["invalid_code", "revoked"]);
});

test("link code: a fresh code for the same hwid invalidates the older unused one", async () => {
  const u = await mkUser();
  const old = await code(u.hwid, u.id);
  const fresh = await code(u.hwid, u.id);
  assert.equal((await redeem(old, nextTg())).reason, "invalid_code");
  assert.equal((await redeem(fresh, nextTg())).ok, true);
});

test("link: one ACTIVE link per telegram account; linked account cannot burn another code", async () => {
  const a = await mkUser(); const b = await mkUser();
  const t = nextTg();
  assert.equal((await redeem(await code(a.hwid, a.id), t)).ok, true);
  const hB = await code(b.hwid, b.id);
  const second = await redeem(hB, t);
  assert.deepEqual([second.ok, second.reason], [false, "already_linked"]);
  // ...and B's code was NOT consumed by the refused attempt.
  assert.equal((await redeem(hB, nextTg())).ok, true);
});

test("re-link: a new code for an already-linked hwid replaces the old telegram account (history kept)", async () => {
  const u = await mkUser();
  const tOld = nextTg(); const tNew = nextTg();
  assert.equal((await redeem(await code(u.hwid, u.id), tOld)).ok, true);
  const r = await redeem(await code(u.hwid, u.id), tNew);
  assert.equal(r.ok, true);
  assert.equal(r.replaced_previous, true);
  const rows = await db.query<{ telegram_user_id: string; revoked_by: string | null }>(
    `SELECT telegram_user_id::text, revoked_by FROM telegram_links WHERE hwid = $1 ORDER BY linked_at, id`, [u.hwid]);
  assert.equal(rows.rows.length, 2);
  const active = rows.rows.filter((x) => x.revoked_by === null);
  assert.equal(active.length, 1);
  assert.equal(active[0].telegram_user_id, String(tNew));
  assert.equal(rows.rows.find((x) => x.revoked_by)?.revoked_by, "relink");
  // old account is now unlinked
  const ctx = await db.query<{ tg_get_context: { linked: boolean } }>(`SELECT tg_get_context($1)`, [tOld]);
  assert.equal(ctx.rows[0].tg_get_context.linked, false);
});

test("unique indexes make a second ACTIVE link per hwid / per telegram account impossible at the table level", async () => {
  const u = await mkUser();
  const t = nextTg();
  await redeem(await code(u.hwid, u.id), t);
  await assert.rejects(() => db.query(`INSERT INTO telegram_links (telegram_user_id, hwid) VALUES ($1, $2)`, [t, uniq("other")]));
  await db.query(`INSERT INTO telegram_users (telegram_user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [t + 100000]);
  await assert.rejects(() => db.query(`INSERT INTO telegram_links (telegram_user_id, hwid) VALUES ($1, $2)`, [t + 100000, u.hwid]));
});

test("get_context/set_language: strangers leave no row; /lang creates one; username refreshes", async () => {
  const stranger = nextTg();
  const c0 = (await db.query<{ tg_get_context: Record<string, unknown> }>(`SELECT tg_get_context($1,'newbie')`, [stranger])).rows[0].tg_get_context;
  assert.deepEqual([c0.known, c0.linked, c0.language], [false, false, null]);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM telegram_users WHERE telegram_user_id = $1`, [stranger]);
  assert.equal(n.rows[0].n, 0);

  await db.query(`SELECT tg_set_language($1,'newbie','en')`, [stranger]);
  const c1 = (await db.query<{ tg_get_context: Record<string, unknown> }>(`SELECT tg_get_context($1,'renamed')`, [stranger])).rows[0].tg_get_context;
  assert.deepEqual([c1.known, c1.language, c1.username], [true, "en", "renamed"]);
  await assert.rejects(() => db.query(`SELECT tg_set_language($1,'x','fr')`, [stranger]));
});

// ── tg_submit_links ──────────────────────────────────────────────────────────

test("submit: not linked -> not_linked and NOTHING is written", async () => {
  const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM video_submissions`)).rows[0].n;
  const r = await submit(nextTg(), nextUpd(), [item("7000000000000000001")]);
  assert.deepEqual([r.ok, r.reason], [false, "not_linked"]);
  const after = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM video_submissions`)).rows[0].n;
  assert.equal(after, before);
});

test("submit: accepted, then duplicate for the same user, then duplicate_other flags the ORIGINAL and logs the attempt", async () => {
  const t1 = nextTg(); const t2 = nextTg();
  await linked(t1); await linked(t2);
  const it = item("7000000000000000010");

  const a = await submit(t1, nextUpd(), [it]);
  assert.equal(a.ok, true);
  assert.equal(a.results[0].outcome, "accepted");
  assert.equal(a.today_count, 1);

  const d = await submit(t1, nextUpd(), [it]);
  assert.equal(d.results[0].outcome, "duplicate");
  assert.equal(d.today_count, 1);

  const updOther = nextUpd();
  const o = await submit(t2, updOther, [it]);
  assert.equal(o.results[0].outcome, "duplicate_other");
  assert.equal(o.results[0].id, a.results[0].id);
  // Retrying the SAME update by the same second user must not double-log.
  await submit(t2, updOther, [it]);

  const row = await db.query<{ flags: string[]; telegram_user_id: string }>(`SELECT flags, telegram_user_id::text FROM video_submissions WHERE id = $1`, [a.results[0].id]);
  assert.deepEqual(row.rows[0].flags, ["duplicate_of_other_user"]);
  assert.equal(row.rows[0].telegram_user_id, String(t1)); // first submitter keeps it
  const att = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM telegram_duplicate_attempts WHERE submission_id = $1`, [a.results[0].id]);
  assert.equal(att.rows[0].n, 1);
  // Only ONE video_submissions row for that canonical URL, ever.
  const cnt = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM video_submissions WHERE canonical_url = $1`, [it.canonical_url]);
  assert.equal(cnt.rows[0].n, 1);
});

test("submit: a Telegram RETRY of the same update reports accepted, never a false 'duplicate'", async () => {
  const t = nextTg(); await linked(t);
  const u = nextUpd();
  const items = [item("7000000000000000020"), item("7000000000000000021")];
  const first = await submit(t, u, items);
  assert.deepEqual(first.results.map((x) => x.outcome), ["accepted", "accepted"]);
  const retry = await submit(t, u, items);
  assert.deepEqual(retry.results.map((x) => x.outcome), ["accepted", "accepted"]);
  assert.equal(retry.today_count, 2);
});

test("submit: batch of mixed outcomes; platform x; short-link + inactive-license flags; username fallback", async () => {
  const t = nextTg();
  const u = await mkUser();
  await mkLicense(u.hwid, "revoked"); // no active license
  assert.equal((await redeem(await code(u.hwid, u.id), t)).ok, true);
  const r = await submit(t, nextUpd(), [
    item("7000000000000000030"),
    item("7000000000000000031", { platform: "x", canonical_url: "https://x.com/i/status/7000000000000000031", video_url: "https://x.com/a/status/7000000000000000031", username: "" }),
    item("7000000000000000032", { opaque: true, canonical_url: "https://vm.tiktok.com/ZMabc32", video_url: "https://vm.tiktok.com/ZMabc32" }),
  ]);
  assert.equal(r.license_active, false);
  assert.deepEqual(r.results.map((x) => x.outcome), ["accepted", "accepted", "accepted"]);
  const rows = await db.query<{ platform: string; username: string; flags: string[]; source: string }>(
    `SELECT platform, username, flags, source FROM video_submissions WHERE telegram_user_id = $1 ORDER BY canonical_url`, [t]);
  assert.ok(rows.rows.every((x) => x.source === "telegram" && x.flags.includes("license_inactive")));
  assert.equal(rows.rows.find((x) => x.platform === "x")?.username, "unknown");
  assert.ok(rows.rows.some((x) => x.flags.includes("short_link")));
});

test("submit: input hardening - non-array / oversized batches raise; bad platform raises", async () => {
  const t = nextTg(); await linked(t);
  await assert.rejects(() => db.query(`SELECT tg_submit_links($1,$2,NULL,'{"a":1}'::jsonb)`, [t, nextUpd()]));
  await assert.rejects(() => submit(t, nextUpd(), Array.from({ length: 51 }, (_, i) => item(String(BigInt("7100000000000000000") + BigInt(i))))));
  await assert.rejects(() => submit(t, nextUpd(), [item("7000000000000000040", { platform: "facebook" })]));
});

test("submit: a revoked link stops working immediately", async () => {
  const t = nextTg(); await linked(t);
  await db.query(`UPDATE telegram_links SET revoked_at = now(), revoked_by = 'admin' WHERE telegram_user_id = $1 AND revoked_at IS NULL`, [t]);
  const r = await submit(t, nextUpd(), [item("7000000000000000050")]);
  assert.equal(r.reason, "not_linked");
});

// ── Campaign attribution + picker ────────────────────────────────────────────

async function mkCampaign(name: string, status = "active") {
  return (await db.query<{ id: string }>(`INSERT INTO campaigns (name, status) VALUES ($1,$2) RETURNING id`, [name, status])).rows[0].id;
}

test("recent_campaigns: window, distinct, ordered, excludes deleted, limited", async () => {
  const hwid = uniq("hw");
  const [a, b, c, del] = [await mkCampaign("A"), await mkCampaign("B"), await mkCampaign("C"), await mkCampaign("Gone", "deleted")];
  const ins = (cid: string, ago: string) => db.query(`INSERT INTO campaign_exports (campaign_id, hwid, exported_at) VALUES ($1,$2, now() - $3::interval)`, [cid, hwid, ago]);
  await ins(a, "1 hour"); await ins(a, "2 hours"); await ins(b, "30 minutes"); await ins(c, "47 hours"); await ins(del, "10 minutes"); await ins(c, "50 hours");
  await db.query(`INSERT INTO campaign_exports (campaign_id, hwid, exported_at) VALUES ($1,'someone-else', now())`, [a]);
  const r = await db.query<{ name: string }>(`SELECT * FROM tg_recent_campaigns($1, now() - interval '48 hours', 6)`, [hwid]);
  assert.deepEqual(r.rows.map((x) => x.name), ["B", "A", "C"]);
  const lim = await db.query<{ name: string }>(`SELECT * FROM tg_recent_campaigns($1, now() - interval '48 hours', 2)`, [hwid]);
  assert.deepEqual(lim.rows.map((x) => x.name), ["B", "A"]);
  const none = await db.query(`SELECT * FROM tg_recent_campaigns($1, now() - interval '48 hours')`, [uniq("nobody")]);
  assert.equal(none.rows.length, 0);
});

test("campaign picker: bound to user + chat, single-use, expiring, index-checked, only NULL rows change", async () => {
  const t = nextTg(); const other = nextTg();
  await linked(t);
  const [c1, c2] = [await mkCampaign("Pick1"), await mkCampaign("Pick2")];
  const a = await submit(t, nextUpd(), [item("7000000000000000060"), item("7000000000000000061")]);
  const ids = a.results.map((x) => x.id);
  // Founder assigns the 2nd row meanwhile - the pick must not overwrite it.
  const founderCamp = await mkCampaign("Founder");
  await db.query(`UPDATE video_submissions SET campaign_id = $1 WHERE id = $2`, [founderCamp, ids[1]]);

  const mkTok = async (uid: number, chat: number, ttl = "30 minutes", opts = [{ campaign_id: c1, name: "Pick1" }, { campaign_id: c2, name: "Pick2" }]) => {
    const tok = uniq("tok");
    await db.query(`INSERT INTO telegram_pending_choices (token, kind, telegram_user_id, chat_id, payload, expires_at) VALUES ($1,'campaign',$2,$3,$4::jsonb, now() + $5::interval)`,
      [tok, uid, chat, JSON.stringify({ options: opts, submission_ids: ids }), ttl]);
    return tok;
  };
  const apply = async (tok: string, uid: number, chat: number, idx: number) =>
    (await db.query<{ tg_apply_campaign_choice: Record<string, unknown> }>(`SELECT tg_apply_campaign_choice($1,$2,$3,$4)`, [tok, uid, chat, idx])).rows[0].tg_apply_campaign_choice;

  const tok = await mkTok(t, t);
  // Forgeries first - each must fail WITHOUT consuming the token.
  assert.equal((await apply(tok, other, t, 0)).ok, false);        // wrong user
  assert.equal((await apply(tok, t, t + 1, 0)).ok, false);        // wrong chat
  assert.equal((await apply(tok, t, t, 2)).ok, false);            // index out of range
  assert.equal((await apply(tok, t, t, -1)).ok, false);
  assert.equal((await apply("does-not-exist", t, t, 0)).ok, false);
  const good = await apply(tok, t, t, 1);
  assert.deepEqual([good.ok, good.campaign_name, good.updated], [true, "Pick2", 1]);
  assert.equal((await apply(tok, t, t, 1)).ok, false);            // single use / replay
  const rows = await db.query<{ id: string; campaign_id: string }>(`SELECT id, campaign_id FROM video_submissions WHERE id = ANY($1::uuid[])`, [ids]);
  assert.equal(rows.rows.find((r) => r.id === ids[0])?.campaign_id, c2);
  assert.equal(rows.rows.find((r) => r.id === ids[1])?.campaign_id, founderCamp);

  const expired = await mkTok(t, t, "-1 minute");
  assert.equal((await apply(expired, t, t, 0)).ok, false);        // expired
});

test("consume_choice: kind-, user-, chat-bound, single-use, expiring", async () => {
  const t = nextTg();
  const mk = async (kind: string, ttl = "10 minutes") => {
    const tok = uniq("u");
    await db.query(`INSERT INTO telegram_pending_choices (token, kind, telegram_user_id, chat_id, payload, expires_at) VALUES ($1,$2,$3,$3,'{"x":1}'::jsonb, now() + $4::interval)`, [tok, kind, t, ttl]);
    return tok;
  };
  const consume = async (tok: string, kind: string, uid: number, chat: number) =>
    (await db.query<{ tg_consume_choice: { ok: boolean; payload?: unknown } }>(`SELECT tg_consume_choice($1,$2,$3,$4)`, [tok, kind, uid, chat])).rows[0].tg_consume_choice;
  const tok = await mk("unlink");
  assert.equal((await consume(tok, "campaign", t, t)).ok, false);
  assert.equal((await consume(tok, "unlink", t + 1, t)).ok, false);
  assert.equal((await consume(tok, "unlink", t, t + 1)).ok, false);
  assert.deepEqual(await consume(tok, "unlink", t, t), { ok: true, payload: { x: 1 } });
  assert.equal((await consume(tok, "unlink", t, t)).ok, false);
  assert.equal((await consume(await mk("unlink", "-1 minute"), "unlink", t, t)).ok, false);
});

// ── Founder tooling + retention ──────────────────────────────────────────────

test("pending_counts: telegram rows only, unsubmitted only, grouped by campaign+platform", async () => {
  const t = nextTg(); await linked(t);
  const camp = await mkCampaign("Counts");
  const r = await submit(t, nextUpd(), [
    item("7000000000000000070"), item("7000000000000000071"),
    item("7000000000000000072", { platform: "x", canonical_url: "https://x.com/i/status/7000000000000000072", video_url: "https://x.com/i/status/7000000000000000072" }),
  ], camp);
  await db.query(`UPDATE video_submissions SET whop_submitted_at = now() WHERE id = $1`, [r.results[1].id]);
  const c = await db.query<{ platform: string; pending: string }>(`SELECT platform, pending::text FROM tg_pending_counts() WHERE campaign_id = $1 ORDER BY platform`, [camp]);
  assert.deepEqual(c.rows, [{ platform: "tiktok", pending: "1" }, { platform: "x", pending: "1" }]);
});

test("cleanup: deletes only what is past retention", async () => {
  await db.query(`INSERT INTO telegram_updates (update_id, received_at) VALUES (90000001, now() - interval '4 days'), (90000002, now())`);
  await db.query(`INSERT INTO telegram_rate_limits (key, window_start, count) VALUES ('old', now() - interval '5 days', 1), ('fresh', now(), 1)`);
  const u = await mkUser();
  await db.query(`INSERT INTO telegram_link_codes (code_hash, hwid, user_id, expires_at, used_at) VALUES ('oldused', $1, $2, now() - interval '60 days', now() - interval '45 days'), ('freshopen', $1, $2, now() + interval '1 day', NULL)`, [u.hwid, u.id]);
  await db.query(`INSERT INTO telegram_pending_choices (token, kind, telegram_user_id, chat_id, expires_at) VALUES ('oldtok','unlink',1,1, now() - interval '3 days'), ('newtok','unlink',1,1, now() + interval '1 day')`);
  const r = (await db.query<{ tg_cleanup: Record<string, number> }>(`SELECT tg_cleanup(3,2,1,30,90)`)).rows[0].tg_cleanup;
  assert.ok(r.telegram_updates >= 1 && r.telegram_rate_limits >= 1 && r.telegram_link_codes >= 1 && r.telegram_pending_choices >= 1);
  const left = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
  assert.equal(await left(`SELECT count(*)::int AS n FROM telegram_updates WHERE update_id IN (90000001, 90000002)`), 1);
  assert.equal(await left(`SELECT count(*)::int AS n FROM telegram_rate_limits WHERE key IN ('old','fresh')`), 1);
  assert.equal(await left(`SELECT count(*)::int AS n FROM telegram_link_codes WHERE code_hash IN ('oldused','freshopen')`), 1);
  assert.equal(await left(`SELECT count(*)::int AS n FROM telegram_pending_choices WHERE token IN ('oldtok','newtok')`), 1);
});

test("deleting a user cascades away their submissions AND duplicate-attempt trail (no orphans)", async () => {
  const t1 = nextTg(); const t2 = nextTg();
  const u1 = await linked(t1); await linked(t2);
  const it = item("7000000000000000080");
  const a = await submit(t1, nextUpd(), [it]);
  await submit(t2, nextUpd(), [it]);
  await db.query(`DELETE FROM users WHERE id = $1`, [u1.id]);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM telegram_duplicate_attempts WHERE submission_id = $1`, [a.results[0].id]);
  assert.equal(n.rows[0].n, 0);
});

test("pre-041 world: the migration applies on top of a database that already has submissions", async () => {
  const pre = await makePre041();
  const u = (await pre.query<{ id: string }>(`INSERT INTO users (email, hwid) VALUES ('a@example.invalid','pre-hw') RETURNING id`)).rows[0].id;
  await pre.query(`INSERT INTO video_submissions (user_id, hardware_id, platform, video_url, username) VALUES ($1,'pre-hw','tiktok','https://a','a'),($1,'pre-hw','youtube','https://b','a')`, [u]);
  await pre.exec(MIG);
  const r = await pre.query<{ source: string; flags: string[] }>(`SELECT source, flags FROM video_submissions`);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => x.source === "app" && x.flags.length === 0));
});

// ── Store helper functions ───────────────────────────────────────────────────

test("unlink / admin revoke / my_links / today_count / create_choice", async () => {
  const t = nextTg();
  const u = await linked(t);

  // my_links spans sources (their own account), newest first, capped.
  await asRole(db, "anon", `SELECT submit_video_link($1,'youtube','https://youtu.be/fromapp','somebody')`, [u.hwid]);
  const s1 = await submit(t, nextUpd(), [item("7000000000000000090")]);
  assert.equal(s1.ok, true);
  const mine = await db.query<{ source: string; status: string }>(`SELECT * FROM tg_my_links($1, 10)`, [u.hwid]);
  assert.equal(mine.rows.length, 2);
  assert.deepEqual(mine.rows.map((r) => r.source).sort(), ["app", "telegram"]);
  assert.equal((await db.query(`SELECT * FROM tg_my_links($1, 0)`, [u.hwid])).rows.length, 1); // floor of 1
  assert.equal((await db.query(`SELECT * FROM tg_my_links($1, 9999)`, [u.hwid])).rows.length, 2);

  const c = (await db.query<{ tg_today_count: number }>(`SELECT tg_today_count($1)`, [t])).rows[0].tg_today_count;
  assert.equal(c, 1);
  assert.equal((await db.query<{ tg_today_count: number }>(`SELECT tg_today_count($1)`, [nextTg()])).rows[0].tg_today_count, 0);
  await db.query(`UPDATE video_submissions SET submitted_at = now() - interval '2 days' WHERE telegram_user_id = $1`, [t]);
  assert.equal((await db.query<{ tg_today_count: number }>(`SELECT tg_today_count($1)`, [t])).rows[0].tg_today_count, 0);

  const tok = uniq("tok");
  await db.query(`SELECT tg_create_choice($1,'unlink',$2,$2,'{"a":1}'::jsonb,600)`, [tok, t]);
  const ch = await db.query<{ kind: string; payload: unknown }>(`SELECT kind, payload FROM telegram_pending_choices WHERE token = $1`, [tok]);
  assert.deepEqual(ch.rows[0], { kind: "unlink", payload: { a: 1 } });
  await assert.rejects(() => db.query(`SELECT tg_create_choice($1,'bogus',$2,$2,'{}'::jsonb,60)`, [uniq("x"), t]));

  // self unlink
  assert.equal((await db.query<{ tg_unlink: number }>(`SELECT tg_unlink($1)`, [t])).rows[0].tg_unlink, 1);
  assert.equal((await db.query<{ tg_unlink: number }>(`SELECT tg_unlink($1)`, [t])).rows[0].tg_unlink, 0); // honest 0 the second time
  assert.equal((await submit(t, nextUpd(), [item("7000000000000000091")])).reason, "not_linked");

  // admin revoke kills the link AND any open code, and reports counts
  const t2 = nextTg();
  const u2 = await linked(t2);
  const open = await code(u2.hwid, u2.id);
  const rv = (await db.query<{ tg_revoke_link_admin: { links_revoked: number; codes_revoked: number } }>(`SELECT tg_revoke_link_admin($1)`, [u2.hwid])).rows[0].tg_revoke_link_admin;
  assert.deepEqual(rv, { links_revoked: 1, codes_revoked: 1 });
  assert.equal((await redeem(open, nextTg())).reason, "invalid_code");
  const again = (await db.query<{ tg_revoke_link_admin: { links_revoked: number; codes_revoked: number } }>(`SELECT tg_revoke_link_admin($1)`, [u2.hwid])).rows[0].tg_revoke_link_admin;
  assert.deepEqual(again, { links_revoked: 0, codes_revoked: 0 });
  const by = await db.query<{ revoked_by: string }>(`SELECT revoked_by FROM telegram_links WHERE hwid = $1`, [u2.hwid]);
  assert.equal(by.rows[0].revoked_by, "admin");
});
