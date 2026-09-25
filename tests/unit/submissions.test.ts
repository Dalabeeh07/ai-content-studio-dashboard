import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS, cleanQuery, filtersToParams, hasActiveFilters, parsePageParams, sanitizeFilters, validDate, validIso,
} from "../../lib/submissions/filters";
import { applyFilters } from "../../lib/submissions/query";
import { TxtGrouper, csvCell, csvHeaderLine, csvLine, sortForExport, txtFromOrderedRows, type ExportRow } from "../../lib/submissions/export";

const UUID = "3f2b8c1e-7a4d-4e6f-9b1a-0c5d2e8f7a61";

test("sanitizeFilters: junk, wrong types and injection attempts collapse to defaults", () => {
  const f = sanitizeFilters({
    source: "admin", status: "paid", campaign: "'; drop table x;--", platform: "myspace", whop: "maybe",
    flag: ["dup", "x"], from: "2026-13-45", to: "yesterday", q: "a,b(c)*%\\", user: "not-a-uuid",
  } as Record<string, unknown>);
  assert.deepEqual({ ...f, flag: f.flag }, { ...DEFAULT_FILTERS, flag: "dup", q: "a b c" });
  assert.deepEqual(sanitizeFilters(null), DEFAULT_FILTERS);
  assert.deepEqual(sanitizeFilters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(sanitizeFilters({ source: { toString: "x" }, q: 42, campaign: 5 } as never), DEFAULT_FILTERS);
});

test("sanitizeFilters: valid values pass through (uuid lower-cased, arrays take the first value)", () => {
  const f = sanitizeFilters({
    source: "telegram", status: "verified", campaign: UUID.toUpperCase(), platform: "x", whop: "pending",
    flag: "any", from: "2026-09-01", to: "2026-09-30", q: "  tiktok.com/@some_user  ", user: UUID,
  });
  assert.deepEqual(f, {
    source: "telegram", status: "verified", campaign: UUID, platform: "x", whop: "pending", flag: "any",
    from: "2026-09-01", to: "2026-09-30", q: "tiktok.com/@some_user", user: UUID,
  });
  assert.equal(sanitizeFilters({ campaign: "none" }).campaign, "none");
  assert.equal(sanitizeFilters({ source: ["app", "telegram"] }).source, "app");
});

test("cleanQuery: PostgREST syntax characters cannot survive; length capped; unicode letters kept", () => {
  for (const c of [",", "(", ")", "*", "%", "\\", "'", '"', ";", "=", "&", "?", "#", "|", "{", "}", "$"]) {
    assert.ok(!cleanQuery(`a${c}b`).includes(c), c);
  }
  assert.equal(cleanQuery("x".repeat(500)).length, 80);
  assert.equal(cleanQuery("  علي   محمد "), "علي محمد");
  assert.equal(cleanQuery("user@example.com"), "user@example.com");
  assert.equal(cleanQuery("id.eq.5,or(a.eq.1)"), "id.eq.5 or a.eq.1");
});

test("validDate / validIso", () => {
  assert.equal(validDate("2026-02-28"), "2026-02-28");
  for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", "", null, 5, "2026-01-01T00:00:00Z"]) assert.equal(validDate(bad), "", String(bad));
  assert.equal(validIso("2026-09-25T12:00:00.123Z"), "2026-09-25T12:00:00.123Z");
  for (const bad of ["nope", "", null, 5, "x".repeat(100)]) assert.equal(validIso(bad), null, String(bad));
});

test("filtersToParams round-trips and omits defaults; hasActiveFilters", () => {
  assert.equal(filtersToParams(DEFAULT_FILTERS).toString(), "");
  assert.equal(hasActiveFilters(DEFAULT_FILTERS), false);
  const f = sanitizeFilters({ source: "telegram", whop: "pending", campaign: UUID, q: "abc" });
  const p = filtersToParams(f);
  assert.deepEqual(sanitizeFilters(Object.fromEntries(p.entries())), f);
  assert.equal(hasActiveFilters(f), true);
});

test("parsePageParams: only allowed page sizes; page is a bounded positive integer", () => {
  assert.deepEqual(parsePageParams({}), { page: 1, size: 50 });
  assert.deepEqual(parsePageParams({ page: "3", size: "100" }), { page: 3, size: 100 });
  assert.deepEqual(parsePageParams({ page: "0", size: "9999" }), { page: 1, size: 50 });
  assert.deepEqual(parsePageParams({ page: "-4", size: "abc" }), { page: 1, size: 50 });
  assert.deepEqual(parsePageParams({ page: "1.5" }), { page: 1, size: 50 });
  assert.deepEqual(parsePageParams({ page: "999999999" }), { page: 1, size: 50 });
  assert.deepEqual(parsePageParams({ page: ["2", "9"], size: ["200"] }), { page: 2, size: 200 });
});

test("csvCell: RFC-4180 quoting and formula-injection defence", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
  for (const evil of ["=HYPERLINK(\"http://evil\",\"x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
    const out = csvCell(evil);
    assert.ok(out.startsWith("'") || out.startsWith('"\''), `${JSON.stringify(evil)} -> ${out}`);
  }
  assert.equal(csvCell("https://www.tiktok.com/@u/video/1"), "https://www.tiktok.com/@u/video/1"); // ordinary URLs are untouched
});

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  campaign: "Alpha", platform: "tiktok", url: "https://www.tiktok.com/@u/video/1", canonicalUrl: "https://www.tiktok.com/@/video/1",
  userEmail: "a@example.com", hwid: "hw", telegram: "@a", submittedAt: "2026-09-25T10:00:00Z", status: "pending_review",
  whopSubmittedAt: null, source: "telegram", flags: ["short_link", "duplicate_of_other_user"], ...over,
});

test("csvLine has one cell per header and quotes correctly", () => {
  const cols = csvHeaderLine().split(",").length;
  const line = csvLine(row({ userEmail: "=cmd|' /C calc'!A0", campaign: 'Al"pha, Inc' }));
  // Re-parse with a tiny RFC-4180 reader.
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
  }
  cells.push(cur);
  assert.equal(cells.length, cols);
  assert.equal(cells[0], 'Al"pha, Inc');
  assert.equal(cells[4], "'=cmd|' /C calc'!A0");
  assert.equal(cells[11], "short_link duplicate_of_other_user");
});

test("TXT grouping: one URL per line, blank line between campaign/platform groups, headers optional, correct across chunk boundaries", () => {
  const rows = [
    row({ campaign: "Alpha", platform: "instagram", url: "https://i/1" }),
    row({ campaign: "Alpha", platform: "instagram", url: "https://i/2" }),
    row({ campaign: "Alpha", platform: "tiktok", url: "https://t/1" }),
    row({ campaign: "Beta", platform: "tiktok", url: "https://t/2" }),
    row({ campaign: null, platform: "x", url: "https://x/1" }),
  ];
  assert.equal(
    txtFromOrderedRows(rows, false),
    "https://i/1\nhttps://i/2\n\nhttps://t/1\n\nhttps://t/2\n\nhttps://x/1\n",
  );
  const withH = txtFromOrderedRows(rows, true);
  assert.match(withH, /^# Alpha - instagram\nhttps:\/\/i\/1/);
  assert.match(withH, /# \(no campaign\) - x\nhttps:\/\/x\/1\n$/);
  // Feeding the same rows in awkward chunks must give byte-identical output.
  for (const split of [1, 2, 3, 4]) {
    const g = new TxtGrouper(true);
    const out = g.chunk(rows.slice(0, split)) + g.chunk(rows.slice(split));
    assert.equal(out, withH, `split at ${split}`);
  }
  assert.equal(txtFromOrderedRows([], true), "");
  // Every URL is on its own line: line count = URLs + group separators/headers.
  assert.equal(txtFromOrderedRows(rows, false).split("\n").filter((l) => l.startsWith("https://")).length, 5);
});

test("sortForExport matches the server order: campaign name, unassigned last, then platform, then oldest first", () => {
  const out = sortForExport([
    { campaign: null, platform: "x", submittedAt: "2026-01-01" },
    { campaign: "Beta", platform: "tiktok", submittedAt: "2026-01-02" },
    { campaign: "Alpha", platform: "tiktok", submittedAt: "2026-01-03" },
    { campaign: "Alpha", platform: "instagram", submittedAt: "2026-01-05" },
    { campaign: "Alpha", platform: "instagram", submittedAt: "2026-01-04" },
  ]);
  assert.deepEqual(out.map((r) => `${r.campaign}|${r.platform}|${r.submittedAt}`), [
    "Alpha|instagram|2026-01-04", "Alpha|instagram|2026-01-05", "Alpha|tiktok|2026-01-03", "Beta|tiktok|2026-01-02", "null|x|2026-01-01",
  ]);
});

// A recording stand-in for the Supabase filter builder.
function recorder() {
  const calls: { m: string; a: unknown[] }[] = [];
  const fake: unknown = new Proxy({}, { get: (_t, m) => (...a: unknown[]) => { calls.push({ m: String(m), a }); return fake; } });
  return { fake, calls };
}

test("applyFilters is safe on its OWN: hostile free text cannot inject PostgREST syntax into the or=(...) expression", () => {
  for (const evil of ["a,b(c)", "x),id.eq.1,(y", "video_url.ilike.*a*,or(status.eq.verified)", "'; drop table t;--"]) {
    const { fake, calls } = recorder();
    applyFilters(fake, { ...DEFAULT_FILTERS, q: evil }, { userIds: [UUID], telegramIds: [42] });
    const or = calls.find((c) => c.m === "or")!;
    assert.ok(or, `no or() call for ${JSON.stringify(evil)}`);
    const expr = or.a[0] as string;
    // Exactly the five structural terms (3 text columns + user_id.in + telegram_user_id.in), regardless of q.
    const terms = expr.split(/,(?=(?:video_url|username|hardware_id|user_id|telegram_user_id)\.)/);
    assert.equal(terms.length, 5, `${JSON.stringify(evil)} -> ${expr}`);
    for (const t of terms.slice(0, 3)) assert.ok(!/[(),*%]/.test(t.replace(/\.ilike\.\*/, "").replace(/\*$/, "")), `syntax char leaked into: ${t}`);
  }
  const { fake, calls } = recorder();
  applyFilters(fake, { ...DEFAULT_FILTERS, q: "*%,(" }, { userIds: [], telegramIds: [] });
  assert.equal(calls.some((c) => c.m === "or"), false, "a query that sanitises to nothing adds no filter");
});

test("applyFilters: every filter maps to exactly the expected builder call (and asOf / pendingOnly are applied)", () => {
  const { fake, calls } = recorder();
  applyFilters(fake, sanitizeFilters({ source: "telegram", status: "verified", campaign: UUID, platform: "x", whop: "pending", flag: "any", from: "2026-09-01", to: "2026-09-30", user: UUID }),
    { userIds: [], telegramIds: [] }, { asOf: "2026-09-25T00:00:00.000Z" });
  const s = calls.map((c) => `${c.m}(${c.a.map((x) => JSON.stringify(x)).join(",")})`);
  assert.deepEqual(s, [
    'eq("source","telegram")', 'eq("status","verified")', `eq("campaign_id","${UUID}")`, 'eq("platform","x")', 'is("whop_submitted_at",null)',
    'overlaps("flags",["duplicate_of_other_user","license_inactive"])', 'gte("submitted_at","2026-09-01T00:00:00.000Z")', 'lt("submitted_at","2026-10-01T00:00:00.000Z")',
    `eq("user_id","${UUID}")`, 'lte("submitted_at","2026-09-25T00:00:00.000Z")',
  ]);
});
