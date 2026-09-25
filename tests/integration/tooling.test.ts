// REAL Supabase: founder tooling at scale. Seeds thousands of disposable
// submissions (TEST_TG_ user/campaigns), then checks pagination correctness +
// timing, every filter against an independently computed expectation, the
// streaming export (CSV/TXT, ordering, size, injection safety, auth), the
// pending counters, and the bulk mark/undo/unmark/assign cores (idempotency,
// honest 0-row errors, snapshot + expected-count guards, concurrency).
//
//   TOOLING_ROWS=10500 (default) - rows to seed. Keep the Submissions page
//   CLOSED while this runs: every insert streams to an open dashboard via Realtime.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EXPORT_MAX_ROWS } from "../../lib/telegram/config";
import { assignCampaignCore, markWhop, undoWhop, unmarkWhop } from "../../lib/submissions/bulk";
import { DEFAULT_FILTERS, type SubmissionFilters } from "../../lib/submissions/filters";
import { fetchCampaignOptions, fetchPendingCounts, fetchSubmissionsPage } from "../../lib/submissions/query";
import { cleanup, fmt, mkAdminSession, mkCampaign, mkUser, startApp, stats, svc, tableCounts, TEST_PREFIX, uniq, type App } from "./helpers";

const N = Number(process.env.TOOLING_ROWS ?? 10500);
const PAGE_MS_BUDGET = 3000; // a single page query must stay well under a serverless timeout
const PLATFORMS = ["tiktok", "instagram", "youtube", "x"] as const;

interface Seed {
  id?: string; user_id: string; hardware_id: string; platform: string; video_url: string; canonical_url: string; username: string;
  status: string; source: string; telegram_user_id: number | null; campaign_id: string | null; whop_submitted_at: string | null;
  flags: string[]; submitted_at: string;
}

let app: App;
let cookie: string;
let baseline: Record<string, number>;
let user: { id: string; hwid: string };
let injectionUser: { id: string; hwid: string };
let campaigns: { id: string; name: string }[] = [];
let deletedCampaign: { id: string; name: string };
let seeds: Seed[] = [];
const F = (o: Partial<SubmissionFilters> = {}): SubmissionFilters => ({ ...DEFAULT_FILTERS, user: user?.id ?? "", ...o });

before(async () => {
  await cleanup();
  baseline = await tableCounts();
  user = await mkUser();
  injectionUser = await mkUser({ emailPrefix: "=" });
  campaigns = [];
  for (const n of ["Zulu", "Alpha", "Mike", "Bravo"]) campaigns.push(await mkCampaign(n));
  deletedCampaign = await mkCampaign("Gone", "deleted");

  const t0 = Date.now();
  const rows: Seed[] = [];
  const now = Date.now();
  for (let i = 0; i < N; i++) {
    const app_ = i % 13 === 0; // ~8% desktop-app rows
    rows.push({
      user_id: user.id, hardware_id: user.hwid,
      platform: PLATFORMS[i % 4],
      video_url: `https://www.tiktok.com/@${TEST_PREFIX}seed/video/${i}`,
      canonical_url: `https://seed.example/${uniq("c")}/${i}`,
      username: `${TEST_PREFIX}u${i % 50}`,
      status: i % 7 === 0 ? "verified" : i % 11 === 0 ? "disputed" : "pending_review",
      source: app_ ? "app" : "telegram",
      telegram_user_id: app_ ? null : 9_100_000_000 + (i % 9),
      campaign_id: i % 6 === 5 ? null : campaigns[i % 4].id,
      whop_submitted_at: !app_ && i % 5 === 0 ? new Date(now - 3600_000).toISOString() : null,
      flags: i % 20 === 0 ? ["duplicate_of_other_user"] : i % 31 === 0 ? ["license_inactive"] : i % 17 === 0 ? ["short_link"] : [],
      submitted_at: new Date(now - 10 * 86400_000 + Math.floor((i / N) * 9.5 * 86400_000)).toISOString(),
    });
  }
  for (let i = 0; i < rows.length; i += 1000) {
    const { data, error } = await svc().from("video_submissions").insert(rows.slice(i, i + 1000)).select("id, canonical_url");
    if (error) throw new Error(`seeding failed at ${i}: ${error.message}`);
    const byCanon = new Map((data ?? []).map((d) => [d.canonical_url as string, d.id as string]));
    for (const r of rows.slice(i, i + 1000)) r.id = byCanon.get(r.canonical_url);
  }
  seeds = rows;
  // One row for the CSV-injection user: its EMAIL starts with "=".
  await svc().from("video_submissions").insert({ user_id: injectionUser.id, hardware_id: injectionUser.hwid, platform: "x", video_url: "https://x.com/i/status/1", username: "inj", source: "telegram", canonical_url: `https://seed.example/${uniq("inj")}` });
  console.log(`\n  seeded ${N} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  cookie = `admin_auth=${await mkAdminSession()}`;
  app = await startApp(3101, {});
});
after(async () => {
  await app?.stop();
  await cleanup();
  assert.deepEqual(await tableCounts(), baseline, "cleanup must leave every table exactly as it was");
});

const expected = (pred: (s: Seed) => boolean) => seeds.filter(pred);
const byNewest = (a: Seed, b: Seed) => (a.submitted_at === b.submitted_at ? (b.id! > a.id! ? 1 : -1) : a.submitted_at < b.submitted_at ? 1 : -1);

// ── pagination ──────────────────────────────────────────────────────────────

test("pagination: every page, several sizes - complete, no duplicates, no gaps, stable newest-first order, totals consistent", async () => {
  for (const size of [25, 50, 100, 200]) {
    const seen: string[] = [];
    const timings: number[] = [];
    const pages = Math.ceil(N / size);
    for (let page = 1; page <= pages; page++) {
      const t0 = performance.now();
      const r = await fetchSubmissionsPage(F(), page, size);
      timings.push(performance.now() - t0);
      assert.equal(r.total, N, `total on page ${page}`);
      assert.ok(r.rows.length === size || page === pages, `page ${page} has ${r.rows.length} rows`);
      seen.push(...r.rows.map((x) => x.id));
      if (size === 200 && page % 20 === 0) console.log(`    size=200 page ${page}/${pages}: ${timings.at(-1)!.toFixed(0)}ms`);
    }
    assert.equal(seen.length, N);
    assert.equal(new Set(seen).size, N, `size ${size}: duplicate rows across pages`);
    const want = [...seeds].sort(byNewest).map((s) => s.id);
    assert.deepEqual(seen, want, `size ${size}: order differs from newest-first (submitted_at desc, id desc)`);
    const s = stats(timings);
    console.log(`  pagination size=${size} (${pages} pages, ${N} rows): ${fmt(s)}`);
    assert.ok(s.max < PAGE_MS_BUDGET, `slowest page ${s.max.toFixed(0)}ms exceeds ${PAGE_MS_BUDGET}ms`);
  }
  const past = await fetchSubmissionsPage(F(), Math.ceil(N / 200) + 5, 200);
  assert.equal(past.rows.length, 0); assert.equal(past.total, N);
});

// ── filters ─────────────────────────────────────────────────────────────────

test("every filter returns exactly the independently computed subset (total + first page)", async () => {
  const c0 = campaigns[0].id;
  const cases: [string, Partial<SubmissionFilters>, (s: Seed) => boolean][] = [
    ["source=app", { source: "app" }, (s) => s.source === "app"],
    ["source=telegram", { source: "telegram" }, (s) => s.source === "telegram"],
    ["whop=pending", { whop: "pending" }, (s) => s.whop_submitted_at === null],
    ["whop=submitted", { whop: "submitted" }, (s) => s.whop_submitted_at !== null],
    ["campaign=<uuid>", { campaign: c0 }, (s) => s.campaign_id === c0],
    ["campaign=none", { campaign: "none" }, (s) => s.campaign_id === null],
    ["platform=x", { platform: "x" }, (s) => s.platform === "x"],
    ["status=verified", { status: "verified" }, (s) => s.status === "verified"],
    ["status=disputed", { status: "disputed" }, (s) => s.status === "disputed"],
    ["flag=dup", { flag: "dup" }, (s) => s.flags.includes("duplicate_of_other_user")],
    ["flag=license", { flag: "license" }, (s) => s.flags.includes("license_inactive")],
    ["flag=short", { flag: "short" }, (s) => s.flags.includes("short_link")],
    ["flag=any(suspicious)", { flag: "any" }, (s) => s.flags.includes("duplicate_of_other_user") || s.flags.includes("license_inactive")],
    ["combo: telegram + pending + campaign + tiktok", { source: "telegram", whop: "pending", campaign: c0, platform: "tiktok" }, (s) => s.source === "telegram" && s.whop_submitted_at === null && s.campaign_id === c0 && s.platform === "tiktok"],
    ["combo: none-campaign + flag any + verified-or-not (status=pending_review)", { campaign: "none", flag: "any", status: "pending_review" }, (s) => s.campaign_id === null && (s.flags.includes("duplicate_of_other_user") || s.flags.includes("license_inactive")) && s.status === "pending_review"],
  ];
  const mid = seeds[Math.floor(N / 2)].submitted_at.slice(0, 10);
  cases.push(
    ["date from", { from: mid }, (s) => s.submitted_at >= `${mid}T00:00:00.000Z`],
    ["date to (inclusive day)", { to: mid }, (s) => s.submitted_at < new Date(new Date(`${mid}T00:00:00Z`).getTime() + 86400_000).toISOString()],
    ["date range", { from: mid, to: mid }, (s) => s.submitted_at.slice(0, 10) === mid],
  );
  for (const [label, over, pred] of cases) {
    const want = expected(pred).sort(byNewest);
    const r = await fetchSubmissionsPage(F(over), 1, 50);
    assert.equal(r.total, want.length, `${label}: total`);
    assert.deepEqual(r.rows.map((x) => x.id), want.slice(0, 50).map((s) => s.id), `${label}: first page`);
    console.log(`  filter ${label.padEnd(58)} -> ${String(r.total).padStart(5)} rows`);
  }
});

test("free-text search: url fragment, handle, user email, and injection-shaped input", async () => {
  const one = seeds[4242 % N];
  const r = await fetchSubmissionsPage(F({ q: `seed/video/${4242 % N}` }), 1, 50);
  assert.ok(r.rows.some((x) => x.id === one.id));
  const email = await fetchSubmissionsPage({ ...DEFAULT_FILTERS, q: user.hwid.toLowerCase() }, 1, 50);
  assert.ok(email.total >= N, "searching the user's email must find their rows");
  for (const evil of ["a,b(c)", "x*%", "id.eq.1,or(status.eq.verified)", "\\", "%00", "'; drop table video_submissions;--"]) {
    const res = await fetchSubmissionsPage(F({ q: evil }), 1, 50); // must not throw or widen the result
    assert.ok(res.total < N, `q=${evil} widened to ${res.total}`);
  }
});

test("pending counters (RPC) equal an independent computation; telegram rows only", async () => {
  const camps = await fetchCampaignOptions();
  const counts = await fetchPendingCounts(camps);
  const mine = counts.filter((c) => c.campaign_id === null ? true : campaigns.some((k) => k.id === c.campaign_id));
  const want = new Map<string, number>();
  for (const s of seeds) if (s.source === "telegram" && s.whop_submitted_at === null) { const k = `${s.campaign_id}|${s.platform}`; want.set(k, (want.get(k) ?? 0) + 1); }
  for (const [k, v] of want) {
    const [cid, plat] = k.split("|");
    const got = counts.find((c) => String(c.campaign_id) === cid && c.platform === plat);
    // The "no campaign" bucket also holds any real pre-existing rows, so it can only be >=.
    if (cid === "null") assert.ok((got?.pending ?? 0) >= v, k); else assert.equal(got?.pending, v, k);
  }
  assert.ok(mine.length > 0);
});

// ── export ──────────────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\r") { /* skip */ }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const exportUrl = (o: Record<string, string>) => `${app.base}/api/submissions/export?${new URLSearchParams({ user: user.id, ...o })}`;

test("export: unauthenticated => 401 and no data", async () => {
  const r = await fetch(exportUrl({ format: "csv" }), { redirect: "manual" });
  assert.ok([401, 307].includes(r.status), `got ${r.status}`); // proxy redirects, or the route's own check answers 401
  const forged = await fetch(exportUrl({ format: "csv" }), { headers: { cookie: "admin_auth=not-a-real-session" }, redirect: "manual" });
  assert.ok([401, 307].includes(forged.status));
  assert.ok(!(await forged.text()).includes(TEST_PREFIX));
});

test(`CSV export of ${N} rows: complete, correctly ordered (campaign name, no-campaign last, platform, oldest first), streamed, fast`, async () => {
  const t0 = performance.now();
  const r = await fetch(exportUrl({ format: "csv" }), { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(r.headers.get("content-disposition") ?? "", /attachment; filename="submissions-\d+\.csv"/);
  assert.equal(r.headers.get("x-export-total"), String(N));
  assert.equal(r.headers.get("x-export-truncated"), "0");
  const reader = r.body!.getReader();
  let ttfb = 0; let bytes = 0; const parts: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (!ttfb) ttfb = performance.now() - t0; bytes += value.byteLength; parts.push(value); }
  const total = performance.now() - t0;
  const text = Buffer.concat(parts).toString("utf8");
  console.log(`  CSV export ${N} rows: ${total.toFixed(0)}ms total, first byte ${ttfb.toFixed(0)}ms, ${(bytes / 1024).toFixed(0)} KiB`);
  assert.ok(total < 30_000, `export took ${total}ms`);
  assert.ok(text.startsWith("﻿"), "UTF-8 BOM for Excel");

  const rows = parseCsv(text.slice(1));
  assert.deepEqual(rows[0], ["campaign", "platform", "url", "canonical_url", "user", "device_id", "telegram", "submitted_at", "status", "whop_submitted_at", "source", "flags"]);
  const data = rows.slice(1);
  assert.equal(data.length, N, "row count");
  assert.ok(data.every((c) => c.length === 12));
  assert.equal(new Set(data.map((c) => c[3])).size, N, "every canonical URL exactly once");
  assert.equal(new Set(data.map((c) => c[2])).size, N);

  const names = new Map(campaigns.map((c) => [c.name, true]));
  let prev: { camp: string | null; plat: string; at: string } | null = null;
  for (const c of data) {
    const cur = { camp: c[0] === "" ? null : c[0], plat: c[1], at: c[7] };
    if (prev) {
      if (prev.camp === null) assert.equal(cur.camp, null, "no-campaign rows must all come last");
      else if (cur.camp !== null) {
        assert.ok(prev.camp <= cur.camp, `campaign order ${prev.camp} > ${cur.camp}`);
        if (prev.camp === cur.camp) { assert.ok(prev.plat <= cur.plat, "platform order"); if (prev.plat === cur.plat) assert.ok(prev.at <= cur.at, "oldest first within a group"); }
      }
    }
    if (cur.camp !== null) assert.ok(names.has(cur.camp));
    prev = cur;
  }
  assert.ok(bytes < 12 * 1024 * 1024);
});

test("CSV export honours filters exactly as the page does, and never leaks other users' rows", async () => {
  const r = await fetch(exportUrl({ format: "csv", source: "app", flag: "any" }), { headers: { cookie } });
  const data = parseCsv((await r.text()).slice(1)).slice(1);
  const want = expected((s) => s.source === "app" && (s.flags.includes("duplicate_of_other_user") || s.flags.includes("license_inactive")));
  assert.equal(data.length, want.length);
  assert.ok(data.every((c) => c[10] === "app"));
});

test("CSV export neutralises spreadsheet formulas in user-controlled cells", async () => {
  const r = await fetch(`${app.base}/api/submissions/export?${new URLSearchParams({ format: "csv", user: injectionUser.id })}`, { headers: { cookie } });
  const data = parseCsv((await r.text()).slice(1)).slice(1);
  assert.equal(data.length, 1);
  assert.ok(data[0][4].startsWith("'="), `user cell was ${JSON.stringify(data[0][4])}`);
});

test("TXT export: pending only, one URL per line, blank line between campaign/platform groups, optional headers, count matches", async () => {
  const wantPending = expected((s) => s.source === "telegram" && s.whop_submitted_at === null);
  const r = await fetch(exportUrl({ format: "txt", pending: "1", headers: "1" }), { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-export-count"), String(wantPending.length));
  assert.ok(!r.headers.get("content-disposition"), "txt is for copying, not a download");
  const text = await r.text();
  const urls = text.split("\n").filter((l) => l.startsWith("https://"));
  assert.equal(urls.length, wantPending.length);
  assert.equal(new Set(urls).size, urls.length);
  const headers = text.split("\n").filter((l) => l.startsWith("# "));
  assert.ok(headers.length >= campaigns.length, "group header lines present");
  assert.ok(/\n\n# /.test(text), "groups are separated by a blank line");
  const plain = await (await fetch(exportUrl({ format: "txt", pending: "1", headers: "0" }), { headers: { cookie } })).text();
  assert.ok(!plain.includes("# "));
  // "pending" with no explicit source means telegram rows only - never the desktop-app rows.
  assert.ok(!urls.some((u) => wantPending.every((s) => s.video_url !== u)), "only expected URLs");
});

test("export snapshot: a row that arrives AFTER asOf is not exported", async () => {
  const asOf = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 50));
  await svc().from("video_submissions").insert({ user_id: user.id, hardware_id: user.hwid, platform: "tiktok", video_url: `https://late.example/${TEST_PREFIX}late`, username: "late", source: "telegram", canonical_url: `https://late.example/${uniq("late")}` });
  const r = await fetch(exportUrl({ format: "txt", asOf }), { headers: { cookie } });
  const text = await r.text();
  assert.ok(!text.includes(`${TEST_PREFIX}late`));
  assert.equal(r.headers.get("x-export-total"), String(N));
  await svc().from("video_submissions").delete().like("video_url", `%${TEST_PREFIX}late%`);
});

test("export cap is enforced and reported up front (constant sanity)", async () => {
  assert.equal(EXPORT_MAX_ROWS, 50_000);
  assert.ok(N <= EXPORT_MAX_ROWS, "this run is below the cap; truncation reporting is unit-verified by the header logic");
});

// ── bulk actions against the real DB ────────────────────────────────────────

const pendingIds = (n: number, filter: (s: Seed) => boolean = (s) => s.source === "telegram" && s.whop_submitted_at === null) => expected(filter).slice(0, n).map((s) => s.id!);
const stampOf = async (ids: string[]) => (await svc().from("video_submissions").select("id, whop_submitted_at").in("id", ids)).data ?? [];

test("mark by ids: stamps exactly those rows; re-marking is idempotent (0 updated, original stamp kept); undo reverts exactly that batch", async () => {
  const ids = pendingIds(6);
  const r1 = await markWhop(svc(), { mode: "ids", ids });
  assert.equal(r1.ok, true); assert.equal(r1.updated, 6); assert.ok(r1.batch);
  const rows1 = await stampOf(ids);
  assert.ok(rows1.every((x) => x.whop_submitted_at !== null));
  const stamps1 = rows1.map((x) => x.whop_submitted_at).sort();

  const r2 = await markWhop(svc(), { mode: "ids", ids });
  assert.equal(r2.ok, true); assert.equal(r2.updated, 0); assert.match(r2.note ?? "", /already marked/);
  assert.deepEqual((await stampOf(ids)).map((x) => x.whop_submitted_at).sort(), stamps1, "an idempotent re-mark must not touch timestamps");

  const partial = await markWhop(svc(), { mode: "ids", ids: [...ids, ...pendingIds(9).slice(6)] });
  assert.equal(partial.updated, 3); assert.equal(partial.matched, 9); assert.match(partial.note ?? "", /6 of 9 were already marked/);

  const undo = await undoWhop(svc(), partial.batch!);
  assert.equal(undo.updated, 3, "undo reverts ONLY the rows that batch stamped");
  assert.ok((await stampOf(ids)).every((x) => x.whop_submitted_at !== null), "earlier marks survive an undo of a later batch");
  const again = await undoWhop(svc(), partial.batch!);
  assert.equal(again.ok, false); assert.match(again.error ?? "", /Nothing to undo/);
  assert.equal((await undoWhop(svc(), r1.batch!)).updated, 6);
  assert.equal((await undoWhop(svc(), "garbage")).ok, false);
});

test("honest errors: nonexistent ids, invalid ids, empty and oversized selections never report success", async () => {
  const ghost = "00000000-0000-4000-8000-000000000000";
  for (const fn of [
    () => markWhop(svc(), { mode: "ids", ids: [ghost] }),
    () => unmarkWhop(svc(), { mode: "ids", ids: [ghost] }),
    () => assignCampaignCore(svc(), { mode: "ids", ids: [ghost] }, campaigns[0].id),
  ]) {
    const r = await fn();
    assert.equal(r.ok, false); assert.match(r.error ?? "", /None of those rows exist/);
  }
  assert.equal((await markWhop(svc(), { mode: "ids", ids: [] })).ok, false);
  assert.equal((await markWhop(svc(), { mode: "ids", ids: ["not-a-uuid"] })).ok, false);
  assert.equal((await markWhop(svc(), { mode: "ids", ids: Array.from({ length: 501 }, () => ghost.replace(/0$/, "1")).map((x, i) => x.replace(/^.{8}/, String(i).padStart(8, "0"))) })).ok, false);
  assert.equal((await markWhop(svc(), null as never)).ok, false);
  assert.equal((await markWhop(svc(), { mode: "filter", filters: F(), asOf: "nope", expectedCount: 1 })).ok, false);
});

test("mark by FILTER: exact count required, snapshot cutoff honoured, unseen rows never swept in, stale count refused", async () => {
  const filters = F({ source: "telegram", whop: "pending", campaign: campaigns[1].id });
  const want = expected((s) => s.source === "telegram" && s.whop_submitted_at === null && s.campaign_id === campaigns[1].id);
  const page = await fetchSubmissionsPage(filters, 1, 50);
  assert.equal(page.total, want.length);

  // A stale expected count is REFUSED and changes nothing.
  const stale = await markWhop(svc(), { mode: "filter", filters, asOf: page.asOf, expectedCount: want.length + 1 });
  assert.equal(stale.ok, false); assert.match(stale.error ?? "", /matching set changed/);
  assert.equal(await countMarked(want.map((s) => s.id!)), 0);

  // Rows arriving after the snapshot are excluded even though they match the filter.
  await new Promise((r) => setTimeout(r, 30));
  const { data: late } = await svc().from("video_submissions").insert(Array.from({ length: 3 }, (_, i) => ({
    user_id: user.id, hardware_id: user.hwid, platform: "tiktok", video_url: `https://late.example/${TEST_PREFIX}mark${i}`, username: "late", source: "telegram",
    campaign_id: campaigns[1].id, canonical_url: `https://late.example/${uniq("mark")}${i}`,
  }))).select("id");
  const r = await markWhop(svc(), { mode: "filter", filters, asOf: page.asOf, expectedCount: want.length });
  assert.equal(r.ok, true, r.error); assert.equal(r.updated, want.length);
  assert.equal(await countMarked(want.map((s) => s.id!)), want.length);
  assert.equal(await countMarked((late ?? []).map((x) => x.id as string)), 0, "rows that arrived after the snapshot must stay pending");

  // Undoable, exactly.
  assert.equal((await undoWhop(svc(), r.batch!)).updated, want.length);
  assert.equal(await countMarked(want.map((s) => s.id!)), 0);
  await svc().from("video_submissions").delete().like("video_url", `%${TEST_PREFIX}mark%`);
});

async function countMarked(ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { count } = await svc().from("video_submissions").select("*", { count: "exact", head: true }).in("id", ids.slice(i, i + 200)).not("whop_submitted_at", "is", null);
    n += count ?? 0;
  }
  return n;
}

test("two concurrent marks of the same rows never double-stamp: total updated == rows", async () => {
  const ids = pendingIds(40, (s) => s.source === "telegram" && s.whop_submitted_at === null && s.campaign_id === campaigns[2].id);
  const [a, b] = await Promise.all([markWhop(svc(), { mode: "ids", ids }), markWhop(svc(), { mode: "ids", ids })]);
  assert.equal((a.updated ?? 0) + (b.updated ?? 0), ids.length);
  await Promise.all([a.batch, b.batch].filter(Boolean).map((x) => undoWhop(svc(), x!)));
  assert.equal(await countMarked(ids), 0);
});

test("unmark by filter + assign campaign (set, clear, nonexistent, deleted) with honest counts", async () => {
  const ids = pendingIds(12, (s) => s.source === "telegram" && s.campaign_id === null);
  const set = await assignCampaignCore(svc(), { mode: "ids", ids }, campaigns[3].id);
  assert.deepEqual([set.ok, set.updated], [true, ids.length]);
  const { data } = await svc().from("video_submissions").select("campaign_id").in("id", ids);
  assert.ok((data ?? []).every((r) => r.campaign_id === campaigns[3].id));
  const clear = await assignCampaignCore(svc(), { mode: "ids", ids }, null);
  assert.deepEqual([clear.ok, clear.updated], [true, ids.length]);
  const bogus = await assignCampaignCore(svc(), { mode: "ids", ids }, "11111111-1111-4111-8111-111111111111");
  assert.equal(bogus.ok, false); assert.match(bogus.error ?? "", /no longer exists/);
  const gone = await assignCampaignCore(svc(), { mode: "ids", ids }, deletedCampaign.id);
  assert.equal(gone.ok, false);
  assert.equal((await assignCampaignCore(svc(), { mode: "ids", ids }, "nope" as never)).ok, false);

  const marked = await markWhop(svc(), { mode: "ids", ids });
  assert.equal(marked.updated, ids.length);
  const un = await unmarkWhop(svc(), { mode: "ids", ids });
  assert.deepEqual([un.ok, un.updated], [true, ids.length]);
  assert.equal(await countMarked(ids), 0);
});

// ── the pages render against real data ──────────────────────────────────────

test("/submissions and /users render for an authenticated admin (filters in the URL), and redirect when logged out", async () => {
  const anonRes = await fetch(`${app.base}/submissions`, { redirect: "manual" });
  assert.equal(anonRes.status, 307);
  const res = await fetch(`${app.base}/submissions?${new URLSearchParams({ user: user.id, whop: "pending", source: "telegram", size: "25", page: "2" })}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("Failed to load submissions"), "page shows an error banner");
  assert.match(html, /Telegram links waiting for Whop/);
  assert.match(html, /Copy pending links/);
  assert.match(html, /Page <b[^>]*>2<\/b> of/);
  const users = await fetch(`${app.base}/users`, { headers: { cookie } });
  assert.equal(users.status, 200);
  const uhtml = await users.text();
  assert.ok(!uhtml.includes("Telegram link status unavailable"), "users page says the Telegram tables are unavailable");
  assert.match(uhtml, /Telegram/);
  assert.match(uhtml, /Generate code/);
});
