import { serverClient } from "@/lib/supabase";
import type { DuplicateAttempt, PendingCount, SubmissionPlatform, SubmissionRow } from "@/lib/types";
import type { SubmissionFilters } from "./filters";

// Server-only data access for the Submissions page, export route and bulk
// actions. Every entry point funnels through applyFilters(), so the visible
// list, the count, the CSV/TXT export and "select all matching" always agree.

export type Db = NonNullable<ReturnType<typeof serverClient>>;

// The Supabase builder types are deep generics; only these chainable filter
// methods are used, so a structural view keeps applyFilters readable and lets
// the SAME function serve select(), update() and count queries.
interface Filterable {
  eq(c: string, v: unknown): Filterable;
  is(c: string, v: null | boolean): Filterable;
  not(c: string, op: string, v: unknown): Filterable;
  gte(c: string, v: unknown): Filterable;
  lt(c: string, v: unknown): Filterable;
  lte(c: string, v: unknown): Filterable;
  contains(c: string, v: unknown): Filterable;
  overlaps(c: string, v: unknown): Filterable;
  or(expr: string): Filterable;
}

export interface FilterContext {
  userIds: string[];
  telegramIds: number[];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Resolves the parts of a free-text search that live in OTHER tables
 * (user email, telegram username) so applyFilters can stay synchronous. */
export async function buildFilterContext(db: Db, f: SubmissionFilters): Promise<FilterContext> {
  const ctx: FilterContext = { userIds: [], telegramIds: [] };
  if (!f.q) return ctx;
  const pattern = `%${escapeLike(f.q)}%`;
  const [u, t] = await Promise.all([
    db.from("users").select("id").ilike("email", pattern).limit(50),
    db.from("telegram_users").select("telegram_user_id").ilike("username", pattern).limit(50),
  ]);
  if (!u.error) ctx.userIds = (u.data ?? []).map((r) => r.id as string);
  if (!t.error) ctx.telegramIds = (t.data ?? []).map((r) => Number(r.telegram_user_id));
  return ctx;
}

export interface ApplyOptions {
  /** Only rows submitted at or before this instant (snapshot cutoff). */
  asOf?: string;
  /** Force "not yet hand-submitted to Whop" regardless of the filter. */
  pendingOnly?: boolean;
}

export function applyFilters<T>(query: T, f: SubmissionFilters, ctx: FilterContext, opts: ApplyOptions = {}): T {
  let q = query as unknown as Filterable;

  if (f.source !== "all") q = q.eq("source", f.source);
  if (f.status !== "all") q = q.eq("status", f.status);
  if (f.campaign === "none") q = q.is("campaign_id", null);
  else if (f.campaign !== "all") q = q.eq("campaign_id", f.campaign);
  if (f.platform !== "all") q = q.eq("platform", f.platform);
  if (f.whop === "pending" || opts.pendingOnly) q = q.is("whop_submitted_at", null);
  else if (f.whop === "submitted") q = q.not("whop_submitted_at", "is", null);
  if (f.flag === "dup") q = q.contains("flags", ["duplicate_of_other_user"]);
  else if (f.flag === "license") q = q.contains("flags", ["license_inactive"]);
  else if (f.flag === "short") q = q.contains("flags", ["short_link"]);
  else if (f.flag === "any") q = q.overlaps("flags", ["duplicate_of_other_user", "license_inactive"]);
  if (f.from) q = q.gte("submitted_at", `${f.from}T00:00:00.000Z`);
  if (f.to) {
    const next = new Date(`${f.to}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    q = q.lt("submitted_at", next.toISOString());
  }
  if (f.user) q = q.eq("user_id", f.user);
  if (f.q) {
    const parts = [`video_url.ilike.*${f.q}*`, `username.ilike.*${f.q}*`, `hardware_id.ilike.*${f.q}*`];
    if (ctx.userIds.length) parts.push(`user_id.in.(${ctx.userIds.join(",")})`);
    if (ctx.telegramIds.length) parts.push(`telegram_user_id.in.(${ctx.telegramIds.join(",")})`);
    q = q.or(parts.join(","));
  }
  if (opts.asOf) q = q.lte("submitted_at", opts.asOf);

  return q as unknown as T;
}

// ── Page ─────────────────────────────────────────────────────────────────────

const PAGE_SELECT =
  "id, user_id, hardware_id, platform, video_url, username, status, whop_confirmed, submitted_at, updated_at, " +
  "source, telegram_user_id, campaign_id, canonical_url, whop_submitted_at, flags, users(email), campaigns(name)";

export interface SubmissionsPage {
  rows: SubmissionRow[];
  total: number;
  page: number;
  size: number;
  asOf: string;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export async function fetchSubmissionsPage(f: SubmissionFilters, page: number, size: number): Promise<SubmissionsPage> {
  const db = serverClient();
  if (!db) throw new Error("Server not configured (SUPABASE_SERVICE_KEY missing).");

  const asOf = new Date().toISOString();
  const ctx = await buildFilterContext(db, f);
  const from = (page - 1) * size;

  const { data, error, count } = await applyFilters(
    db.from("video_submissions").select(PAGE_SELECT, { count: "exact" }),
    f, ctx, { asOf },
  )
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + size - 1);

  if (error) {
    const hint = /does not exist|column|relationship|schema cache/i.test(error.message)
      ? " - has migration 041_telegram_link_intake.sql been applied in the Supabase SQL Editor?"
      : "";
    throw new Error(`fetchSubmissionsPage: ${error.message}${hint}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (data ?? []) as any[];

  // Secondary lookups are bounded by the page size (never the table size).
  const tgIds = [...new Set(raw.map((r) => r.telegram_user_id).filter((x) => x != null).map(Number))];
  const dupIds = raw.filter((r) => (r.flags ?? []).includes("duplicate_of_other_user")).map((r) => r.id as string);

  const [tgUsers, dups] = await Promise.all([
    tgIds.length
      ? db.from("telegram_users").select("telegram_user_id, username").in("telegram_user_id", tgIds)
      : Promise.resolve({ data: [], error: null }),
    dupIds.length
      ? db.from("telegram_duplicate_attempts").select("submission_id, hwid, user_id, created_at").in("submission_id", dupIds).order("created_at", { ascending: true }).limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const tgName = new Map<number, string | null>();
  for (const t of tgUsers.data ?? []) tgName.set(Number(t.telegram_user_id), (t.username as string | null) ?? null);

  const dupBySub = new Map<string, DuplicateAttempt[]>();
  const dupUserIds = [...new Set((dups.data ?? []).map((d) => d.user_id).filter(Boolean) as string[])];
  const emailById = new Map<string, string | null>();
  if (dupUserIds.length) {
    const { data: us } = await db.from("users").select("id, email").in("id", dupUserIds);
    for (const u of us ?? []) emailById.set(u.id as string, (u.email as string | null) ?? null);
  }
  for (const d of dups.data ?? []) {
    const list = dupBySub.get(d.submission_id as string) ?? [];
    list.push({
      who: (d.user_id && emailById.get(d.user_id as string)) || `User #${String(d.hwid ?? "?").slice(0, 6)}`,
      at: d.created_at as string,
    });
    dupBySub.set(d.submission_id as string, list);
  }

  const rows: SubmissionRow[] = raw.map((s) => ({
    id: s.id,
    user_id: s.user_id,
    hardware_id: s.hardware_id,
    user_email: (one(s.users) as { email: string | null } | null)?.email ?? null,
    platform: s.platform as SubmissionPlatform,
    video_url: s.video_url,
    username: s.username,
    status: s.status,
    whop_confirmed: Boolean(s.whop_confirmed),
    submitted_at: s.submitted_at,
    updated_at: s.updated_at,
    source: s.source === "telegram" ? "telegram" : "app",
    telegram_user_id: s.telegram_user_id == null ? null : Number(s.telegram_user_id),
    telegram_username: s.telegram_user_id == null ? null : (tgName.get(Number(s.telegram_user_id)) ?? null),
    campaign_id: s.campaign_id ?? null,
    campaign_name: (one(s.campaigns) as { name: string } | null)?.name ?? null,
    canonical_url: s.canonical_url ?? null,
    whop_submitted_at: s.whop_submitted_at ?? null,
    flags: Array.isArray(s.flags) ? s.flags : [],
    dup_attempts: dupBySub.get(s.id) ?? [],
  }));

  return { rows, total: count ?? 0, page, size, asOf };
}

// ── Pending-for-Whop counters + campaign list ───────────────────────────────

export interface CampaignOption { id: string; name: string; status: string }

export async function fetchCampaignOptions(): Promise<CampaignOption[]> {
  const db = serverClient();
  if (!db) return [];
  const { data, error } = await db.from("campaigns").select("id, name, status").order("name", { ascending: true }).limit(500);
  if (error) throw new Error(`fetchCampaignOptions: ${error.message}`);
  return (data ?? []) as CampaignOption[];
}

export async function fetchPendingCounts(campaigns: CampaignOption[]): Promise<PendingCount[]> {
  const db = serverClient();
  if (!db) return [];
  const { data, error } = await db.rpc("tg_pending_counts");
  if (error) throw new Error(`fetchPendingCounts: ${error.message}`);
  const name = new Map(campaigns.map((c) => [c.id, c.name]));
  return ((data ?? []) as { campaign_id: string | null; platform: SubmissionPlatform; pending: number | string }[]).map((r) => ({
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_id ? (name.get(r.campaign_id) ?? "(deleted campaign)") : null,
    platform: r.platform,
    pending: Number(r.pending),
  }));
}
