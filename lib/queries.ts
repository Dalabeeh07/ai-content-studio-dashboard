import { serverClient } from "./supabase";
import type { ClipRow, EarningsUserRow, MonthlyBar, PendingUser, SummaryStats, UserRow } from "./types";

export async function fetchUsers(): Promise<UserRow[]> {
  const db = serverClient();
  if (!db) return [];

  // Fetch users + license status via FK (users.license_id → licenses.id)
  const { data: users, error: uErr } = await db
    .from("users")
    .select("*, licenses(status)")
    .order("last_active_at", { ascending: false, nullsFirst: false });

  if (uErr) throw new Error(`fetchUsers: ${uErr.message}`);
  if (!users) return [];

  // Clip counts + earnings for last 30 days per user
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: clipAgg, error: cErr } = await db
    .from("clips")
    .select("hwid, id, earnings, created_at")
    .gte("created_at", thirtyDaysAgo);

  if (cErr) throw new Error(`fetchUsers clips: ${cErr.message}`);

  // Aggregate per hwid
  const clipMap: Record<string, { count: number; earnings: number }> = {};
  for (const c of clipAgg ?? []) {
    const k = c.hwid as string;
    if (!k) continue;
    if (!clipMap[k]) clipMap[k] = { count: 0, earnings: 0 };
    clipMap[k].count += 1;
    clipMap[k].earnings += Number(c.earnings ?? 0);
  }

  return users.map((u) => {
    // The users table's real column is hardware_id (confirmed - this is
    // the same hwid-vs-hardware_id mismatch the deduct_credit RPC had).
    // UserRow.hwid is this dashboard's own established field name, mapped
    // here rather than renamed everywhere it's already used downstream.
    const agg = clipMap[u.hardware_id] ?? { count: 0, earnings: 0 };
    const licRow = Array.isArray(u.licenses) ? u.licenses[0] : u.licenses;
    return {
      id:             u.id,
      hwid:           u.hardware_id,
      email:          u.email ?? null,
      license_key:    u.license_key ?? null,
      status:         u.status ?? null,
      created_at:     u.created_at,
      last_active_at: u.last_active_at ?? null,
      clips_count:      u.clips_count ?? null,
      social_accounts:  Array.isArray(u.social_accounts) ? u.social_accounts : null,
      license_status:   (licRow?.status ?? null) as UserRow["license_status"],
      clip_count_30d: agg.count,
      total_earnings: agg.earnings,
    };
  });
}

// ── Pending users ─────────────────────────────────────────────────────────────

export async function fetchPendingUsers(): Promise<PendingUser[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("pending_users")
    .select(
      "id, hwid, full_name, whop_username, license_key, social_accounts, " +
      "gemini_key_hint, status, created_at:registered_at, reviewed_at"
    )
    .order("registered_at", { ascending: false });

  if (error) throw new Error(`fetchPendingUsers: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((p) => ({
    id:              p.id as string,
    hwid:            p.hwid as string,
    full_name:       p.full_name ?? null,
    whop_username:   p.whop_username ?? null,
    license_key:     p.license_key ?? null,
    social_accounts: Array.isArray(p.social_accounts) ? p.social_accounts : null,
    gemini_key_hint: p.gemini_key_hint ?? null,
    status:          p.status as PendingUser["status"],
    created_at:      p.created_at as string,
    reviewed_at:     p.reviewed_at ?? null,
  } satisfies PendingUser));
}

// ── Clips ─────────────────────────────────────────────────────────────────────

export async function fetchClips(): Promise<ClipRow[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("clips")
    .select("id, hwid, created_at, status, earnings, users(email)")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`fetchClips: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((c) => {
    const uRow = Array.isArray(c.users) ? c.users[0] : c.users;
    return {
      id:         c.id as string,
      hwid:       c.hwid as string | null,
      user_email: (uRow as { email: string | null } | null)?.email ?? null,
      created_at: c.created_at as string,
      status:     c.status as string | null,
      earnings:   c.earnings as number | null,
    } satisfies ClipRow;
  });
}

// ── Earnings ──────────────────────────────────────────────────────────────────

const USER_SHARE = 0.6;
const ADMIN_SHARE = 0.4;

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
  "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
  "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};

export async function fetchEarnings(): Promise<{
  rows: EarningsUserRow[];
  monthly: MonthlyBar[];
  totals: { gross: number; userShare: number; adminShare: number };
}> {
  const db = serverClient();
  if (!db) return { rows: [], monthly: [], totals: { gross: 0, userShare: 0, adminShare: 0 } };

  const { data: clips, error } = await db
    .from("clips")
    .select("hwid, earnings, created_at, users(email)")
    .not("earnings", "is", null);

  if (error) throw new Error(`fetchEarnings: ${error.message}`);

  // Per-user aggregation
  const userMap: Record<
    string,
    { email: string | null; gross: number; published: number }
  > = {};

  // Monthly aggregation (ISO month key "YYYY-MM")
  const monthMap: Record<string, number> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of ((clips ?? []) as any[])) {
    const hwid = c.hwid as string | null;
    if (!hwid) continue;

    const uRow = Array.isArray(c.users) ? c.users[0] : c.users;
    const email = (uRow as { email: string | null } | null)?.email ?? null;
    const gross = Number(c.earnings ?? 0);

    if (!userMap[hwid]) {
      userMap[hwid] = { email, gross: 0, published: 0 };
    }
    userMap[hwid].gross     += gross;
    userMap[hwid].published += 1;

    // Monthly
    const month = (c.created_at as string).slice(0, 7); // "YYYY-MM"
    monthMap[month] = (monthMap[month] ?? 0) + gross;
  }

  // Build user rows, sorted by gross earnings desc
  const rows: EarningsUserRow[] = Object.entries(userMap)
    .map(([hwid, agg]) => ({
      hwid,
      user_email:     agg.email,
      gross_earnings: agg.gross,
      user_share:     agg.gross * USER_SHARE,
      admin_share:    agg.gross * ADMIN_SHARE,
      published_clips: agg.published,
    }))
    .sort((a, b) => b.gross_earnings - a.gross_earnings);

  // Build last-6-months bars
  const now = new Date();
  const monthly: MonthlyBar[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const gross = monthMap[key] ?? 0;
    monthly.push({
      month:      key,
      label:      MONTH_LABELS[key.slice(5)] ?? key.slice(5),
      gross,
      user_share: gross * USER_SHARE,
      admin_share: gross * ADMIN_SHARE,
    });
  }

  const totalGross = rows.reduce((s, r) => s + r.gross_earnings, 0);
  return {
    rows,
    monthly,
    totals: {
      gross:      totalGross,
      userShare:  totalGross * USER_SHARE,
      adminShare: totalGross * ADMIN_SHARE,
    },
  };
}

export async function fetchSummary(users: UserRow[]): Promise<SummaryStats> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const db = serverClient();
  if (!db) return { total_users: users.length, active_today: 0, total_clips: 0, total_earnings: 0 };

  const { count: totalClips } = await db
    .from("clips")
    .select("id", { count: "exact", head: true });

  const activeToday = users.filter(
    (u) => u.last_active_at && u.last_active_at >= oneDayAgo
  ).length;

  const totalEarnings = users.reduce((s, u) => s + u.total_earnings, 0);

  return {
    total_users:    users.length,
    active_today:   activeToday,
    total_clips:    totalClips ?? 0,
    total_earnings: totalEarnings,
  };
}
