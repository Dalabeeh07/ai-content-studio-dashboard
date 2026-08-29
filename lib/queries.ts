import { serverClient } from "./supabase";
import type { ClipRow, EarningsUserRow, MonthlyBar, SummaryStats, UserRow } from "./types";

export async function fetchUsers(): Promise<UserRow[]> {
  const db = serverClient();

  // Fetch users + license status
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
    .select("user_hardware_id, id, estimated_earnings_usd, exported_at")
    .gte("exported_at", thirtyDaysAgo);

  if (cErr) throw new Error(`fetchUsers clips: ${cErr.message}`);

  // Aggregate per hardware_id
  const clipMap: Record<string, { count: number; earnings: number }> = {};
  for (const c of clipAgg ?? []) {
    const k = c.user_hardware_id as string;
    if (!k) continue;
    if (!clipMap[k]) clipMap[k] = { count: 0, earnings: 0 };
    clipMap[k].count += 1;
    clipMap[k].earnings += Number(c.estimated_earnings_usd ?? 0);
  }

  return users.map((u) => {
    const agg = clipMap[u.hardware_id] ?? { count: 0, earnings: 0 };
    const licRow = Array.isArray(u.licenses) ? u.licenses[0] : u.licenses;
    return {
      id:              u.id,
      hardware_id:     u.hardware_id,
      license_key:     u.license_key,
      whop_username:   u.whop_username,
      social_usernames: u.social_usernames ?? {},
      created_at:      u.created_at,
      last_active_at:  u.last_active_at,
      license_status:  (licRow?.status ?? null) as UserRow["license_status"],
      clip_count_30d:  agg.count,
      total_earnings:  agg.earnings,
    };
  });
}

// ── Clips ─────────────────────────────────────────────────────────────────────

export async function fetchClips(): Promise<ClipRow[]> {
  const db = serverClient();

  const { data, error } = await db
    .from("clips")
    .select(
      "id, user_hardware_id, filename, content_type, duration_sec, score," +
      " exported_at, published_url, platform, views, estimated_earnings_usd," +
      " users(whop_username)"
    )
    .order("exported_at", { ascending: false });

  if (error) throw new Error(`fetchClips: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((c) => {
    const uRow = Array.isArray(c.users) ? c.users[0] : c.users;
    return {
      id:                     c.id as string,
      user_hardware_id:       c.user_hardware_id as string | null,
      whop_username:          (uRow as { whop_username: string | null } | null)?.whop_username ?? null,
      filename:               c.filename as string,
      content_type:           c.content_type as string,
      duration_sec:           c.duration_sec as number | null,
      score:                  c.score as number | null,
      exported_at:            c.exported_at as string,
      published_url:          c.published_url as string | null,
      platform:               c.platform as string | null,
      views:                  c.views as number | null,
      estimated_earnings_usd: c.estimated_earnings_usd as number | null,
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

  const { data: clips, error } = await db
    .from("clips")
    .select(
      "user_hardware_id, views, estimated_earnings_usd, published_url, exported_at," +
      " users(whop_username)"
    )
    .not("published_url", "is", null);

  if (error) throw new Error(`fetchEarnings: ${error.message}`);

  // Per-user aggregation
  const userMap: Record<
    string,
    { username: string | null; views: number; gross: number; published: number }
  > = {};

  // Monthly aggregation (ISO month key "YYYY-MM")
  const monthMap: Record<string, number> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of ((clips ?? []) as any[])) {
    const hwid = c.user_hardware_id as string | null;
    if (!hwid) continue;

    const uRow = Array.isArray(c.users) ? c.users[0] : c.users;
    const username = (uRow as { whop_username: string | null } | null)?.whop_username ?? null;
    const gross = Number(c.estimated_earnings_usd ?? 0);
    const views = Number(c.views ?? 0);

    if (!userMap[hwid]) {
      userMap[hwid] = { username, views: 0, gross: 0, published: 0 };
    }
    userMap[hwid].views     += views;
    userMap[hwid].gross     += gross;
    userMap[hwid].published += 1;

    // Monthly
    const month = (c.exported_at as string).slice(0, 7); // "YYYY-MM"
    monthMap[month] = (monthMap[month] ?? 0) + gross;
  }

  // Build user rows, sorted by gross earnings desc
  const rows: EarningsUserRow[] = Object.entries(userMap)
    .map(([hwid, agg]) => ({
      hardware_id:    hwid,
      whop_username:  agg.username,
      total_views:    agg.views,
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
