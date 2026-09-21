import { serverClient } from "./supabase";
import { ADMIN_SHARE, USER_SHARE } from "./constants";
import type {
  Campaign, CampaignClip, CampaignCompliance, CampaignHook,
  CampaignHookStatusRow, CampaignTermsLogRow, CampaignVideo, ClipRow,
  EarningsUserRow, MonthlyBar, PendingUser, SubmissionRow, SummaryStats,
  UserRow,
} from "./types";

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
    // The users table has BOTH hwid and hardware_id columns, inconsistently
    // populated - confirmed live via direct REST probes: 406 of 407 real
    // rows have hwid set and hardware_id null, exactly 1 has the reverse
    // (see supabase/migrations/013_defensive_hwid_reads.sql for the full
    // writeup and the matching RPC-side fix). Reading only u.hardware_id
    // here meant this dashboard showed a blank Device ID and a 0 clip
    // count for the vast majority of real users - not because they had no
    // clips, but because the join key itself was wrong. Resolve once,
    // preferring hwid (the far more populated column) with hardware_id as
    // fallback for that one legacy row, and use the SAME resolved value
    // for both the clip-count join below and the row's own hwid field.
    const resolvedHwid: string | null = u.hwid ?? u.hardware_id ?? null;
    const agg = (resolvedHwid && clipMap[resolvedHwid]) || { count: 0, earnings: 0 };
    const licRow = Array.isArray(u.licenses) ? u.licenses[0] : u.licenses;
    return {
      id:             u.id,
      hwid:           resolvedHwid,
      email:          u.email ?? null,
      license_key:    u.license_key ?? null,
      status:         u.status ?? null,
      created_at:     u.created_at,
      last_active_at: u.last_active_at ?? null,
      clips_count:      u.clips_count ?? null,
      videos_analyzed_count: u.videos_analyzed_count ?? null,
      last_analysis_at:      u.last_analysis_at ?? null,
      exports_count:         u.exports_count ?? null,
      last_export_at:        u.last_export_at ?? null,
      last_explicit_close_at: u.last_explicit_close_at ?? null,
      social_accounts:  Array.isArray(u.social_accounts) ? u.social_accounts : null,
      daily_limit:    u.daily_limit ?? 0,
      daily_used:     u.daily_used ?? 0,
      daily_bonus:    u.daily_bonus ?? 0,
      daily_reset_at: u.daily_reset_at,
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

// ── Video submissions (revenue-share) ──────────────────────────────────────────

export async function fetchSubmissions(): Promise<SubmissionRow[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("video_submissions")
    .select(
      "id, user_id, hardware_id, platform, video_url, username, status, " +
      "whop_confirmed, submitted_at, updated_at, users(email)"
    )
    .order("submitted_at", { ascending: false });

  if (error) throw new Error(`fetchSubmissions: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((s) => {
    const uRow = Array.isArray(s.users) ? s.users[0] : s.users;
    return {
      id:             s.id as string,
      user_id:        s.user_id as string,
      hardware_id:    s.hardware_id as string,
      user_email:     (uRow as { email: string | null } | null)?.email ?? null,
      platform:       s.platform as SubmissionRow["platform"],
      video_url:      s.video_url as string,
      username:       s.username as string,
      status:         s.status as SubmissionRow["status"],
      whop_confirmed: Boolean(s.whop_confirmed),
      submitted_at:   s.submitted_at as string,
      updated_at:     s.updated_at as string,
    } satisfies SubmissionRow;
  });
}

// ── Earnings ──────────────────────────────────────────────────────────────────

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
  "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
  "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};

export async function fetchEarnings(): Promise<{
  rows: EarningsUserRow[];
  monthly: MonthlyBar[];
  totals: {
    gross: number;
    userShare: number;
    adminShare: number;
    pendingUserShare: number;
    paidUserShare: number;
  };
}> {
  const db = serverClient();
  if (!db) {
    return {
      rows: [],
      monthly: [],
      totals: { gross: 0, userShare: 0, adminShare: 0, pendingUserShare: 0, paidUserShare: 0 },
    };
  }

  const { data: clips, error } = await db
    .from("clips")
    .select("hwid, earnings, created_at, payout_status, users(email)")
    .not("earnings", "is", null);

  if (error) throw new Error(`fetchEarnings: ${error.message}`);

  // Per-user aggregation
  const userMap: Record<
    string,
    { email: string | null; gross: number; pending: number; published: number }
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
    // Defensive: treat anything but the literal 'paid' as unpaid, so a row
    // from before this column existed (null) still counts as pending.
    const isPaid = c.payout_status === "paid";

    if (!userMap[hwid]) {
      userMap[hwid] = { email, gross: 0, pending: 0, published: 0 };
    }
    userMap[hwid].gross     += gross;
    userMap[hwid].published += 1;
    if (!isPaid) userMap[hwid].pending += gross;

    // Monthly
    const month = (c.created_at as string).slice(0, 7); // "YYYY-MM"
    monthMap[month] = (monthMap[month] ?? 0) + gross;
  }

  // Build user rows, sorted by gross earnings desc
  const rows: EarningsUserRow[] = Object.entries(userMap)
    .map(([hwid, agg]) => {
      const pendingUserShare = agg.pending * USER_SHARE;
      return {
        hwid,
        user_email:     agg.email,
        gross_earnings: agg.gross,
        user_share:     agg.gross * USER_SHARE,
        admin_share:    agg.gross * ADMIN_SHARE,
        pending_user_share: pendingUserShare,
        paid_user_share:    (agg.gross - agg.pending) * USER_SHARE,
        published_clips: agg.published,
        fully_paid: pendingUserShare === 0,
      };
    })
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
  const pendingUserShare = rows.reduce((s, r) => s + r.pending_user_share, 0);
  return {
    rows,
    monthly,
    totals: {
      gross:      totalGross,
      userShare:  totalGross * USER_SHARE,
      adminShare: totalGross * ADMIN_SHARE,
      pendingUserShare,
      paidUserShare: rows.reduce((s, r) => s + r.paid_user_share, 0),
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

// ── Campaign-based automatic hooks (migration 027) ──────────────────────────

export async function fetchCampaigns(): Promise<Campaign[]> {
  const db = serverClient();
  if (!db) return [];

  const { data: campaigns, error: cErr } = await db
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (cErr) throw new Error(`fetchCampaigns: ${cErr.message}`);
  if (!campaigns) return [];

  const { data: hooks, error: hErr } = await db
    .from("campaign_hooks")
    .select("campaign_id, status");
  if (hErr) throw new Error(`fetchCampaigns hooks: ${hErr.message}`);

  const poolAgg: Record<string, { total: number; available: number; claimed: number }> = {};
  for (const h of hooks ?? []) {
    const k = h.campaign_id as string;
    if (!poolAgg[k]) poolAgg[k] = { total: 0, available: 0, claimed: 0 };
    poolAgg[k].total += 1;
    if (h.status === "available") poolAgg[k].available += 1;
    if (h.status === "claimed") poolAgg[k].claimed += 1;
  }

  return campaigns.map((c) => {
    const pool = poolAgg[c.id] ?? { total: 0, available: 0, claimed: 0 };
    return {
      id: c.id,
      name: c.name,
      content_type: c.content_type,
      terms_text: c.terms_text ?? "",
      status: c.status,
      created_at: c.created_at,
      total_hooks: pool.total,
      available_hooks: pool.available,
      claimed_hooks: pool.claimed,
    };
  });
}

// Lightweight per-hook-row fetch (id/campaign_id/status only) purely to seed
// CampaignsPanel.tsx's live hook-count Realtime patching - see
// CampaignHookStatusRow's own doc comment in lib/types.ts for why a bare
// aggregate can't be live-patched from a single UPDATE event alone.
export async function fetchCampaignHookStatuses(): Promise<CampaignHookStatusRow[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db.from("campaign_hooks").select("id, campaign_id, status");
  if (error) throw new Error(`fetchCampaignHookStatuses: ${error.message}`);

  return (data ?? []).map((h) => ({
    id: h.id,
    campaign_id: h.campaign_id,
    status: h.status,
  }));
}

export async function fetchCampaignHooks(campaignId: string): Promise<CampaignHook[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("campaign_hooks")
    .select("*, claimed_user:users!campaign_hooks_claimed_by_user_id_fkey(email)")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`fetchCampaignHooks: ${error.message}`);
  if (!data) return [];

  return data.map((h) => {
    const claimedUser = Array.isArray(h.claimed_user) ? h.claimed_user[0] : h.claimed_user;
    return {
      id: h.id,
      campaign_id: h.campaign_id,
      text: h.text,
      status: h.status,
      claimed_by_hwid: h.claimed_by_hwid ?? null,
      claimed_by_user_id: h.claimed_by_user_id ?? null,
      claimed_by_email: claimedUser?.email ?? null,
      claimed_at: h.claimed_at ?? null,
      created_at: h.created_at,
    };
  });
}

// ── Content marketplace pivot (migration 028) ────────────────────────────────

export async function fetchCampaignVideos(campaignId: string): Promise<CampaignVideo[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("campaign_videos")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`fetchCampaignVideos: ${error.message}`);
  if (!data) return [];

  return data.map((v) => ({
    id: v.id,
    campaign_id: v.campaign_id,
    original_filename: v.original_filename,
    storage_path: v.storage_path,
    status: v.status,
    claimed_by_hwid: v.claimed_by_hwid ?? null,
    claimed_at: v.claimed_at ?? null,
    heartbeat_at: v.heartbeat_at ?? null,
    progress_fraction: v.progress_fraction ?? 0,
    progress_message: v.progress_message ?? null,
    error_message: v.error_message ?? null,
    duration_seconds: v.duration_seconds ?? null,
    created_at: v.created_at,
    completed_at: v.completed_at ?? null,
  }));
}

// All of a campaign's clips in one query, grouped by campaign_video_id
// client-side (CampaignVideosPanel.tsx) - cheaper than one query per video
// row, and this table has no Realtime grant (migration 029's header: the
// founder's own revalidatePath after his own delete/upload actions is
// sufficient, nothing here needs to update live for a second viewer).
export async function fetchCampaignClips(campaignId: string): Promise<CampaignClip[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("campaign_clips")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`fetchCampaignClips: ${error.message}`);
  if (!data) return [];

  return data.map((c) => ({
    id: c.id,
    campaign_video_id: c.campaign_video_id,
    campaign_id: c.campaign_id,
    storage_path: c.storage_path,
    start_seconds: c.start_seconds,
    end_seconds: c.end_seconds,
    duration_seconds: c.duration_seconds,
    created_at: c.created_at,
  }));
}

// Compliance/stats view: who has opened+agreed to this campaign's terms
// (one campaign_terms_log row per open, re-logged every time - so the
// distinct-user count below, not the row count, is "how many people"),
// plus the campaign's overall export total. Deliberately does NOT resolve
// which user exported which specific clip - the founder said that view
// isn't needed.
export async function fetchCampaignCompliance(campaignId: string): Promise<CampaignCompliance> {
  const db = serverClient();
  if (!db) return { openedCount: 0, exportedCount: 0, log: [] };

  const { data: logRows, error: lErr } = await db
    .from("campaign_terms_log")
    .select("id, campaign_id, user_id, hwid, accepted_at, users(email)")
    .eq("campaign_id", campaignId)
    .order("accepted_at", { ascending: false });
  if (lErr) throw new Error(`fetchCampaignCompliance log: ${lErr.message}`);

  const { count: exportedCount, error: eErr } = await db
    .from("campaign_exports")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (eErr) throw new Error(`fetchCampaignCompliance exports: ${eErr.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log: CampaignTermsLogRow[] = ((logRows ?? []) as any[]).map((r) => {
    const uRow = Array.isArray(r.users) ? r.users[0] : r.users;
    return {
      id: r.id as string,
      campaign_id: r.campaign_id as string,
      user_id: (r.user_id as string | null) ?? null,
      hwid: r.hwid as string,
      accepted_at: r.accepted_at as string,
      user_email: (uRow as { email: string | null } | null)?.email ?? null,
    } satisfies CampaignTermsLogRow;
  });

  // "How many people have opened this campaign" - dedupe by user_id when
  // known, falling back to hwid (user_id is nullable: a hwid with no
  // matching users row at open time still counts as one distinct opener).
  const distinct = new Set(log.map((r) => r.user_id ?? r.hwid));

  return { openedCount: distinct.size, exportedCount: exportedCount ?? 0, log };
}
