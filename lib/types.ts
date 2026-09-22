export type LicenseStatus = "active" | "expired" | "revoked";

export interface SocialAccount {
  platform: string;
  username: string;
}

export interface UserRow {
  id: string;
  // Resolved from whichever of users.hwid/users.hardware_id is actually
  // populated (see lib/queries.ts's fetchUsers) - genuinely null only if
  // a row somehow has neither set.
  hwid: string | null;
  email: string | null;
  license_key: string | null;
  status: string | null;
  created_at: string;
  last_active_at: string | null;
  clips_count: number | null;
  // Live activity tracking (migration 011) - videos_analyzed_count/
  // exports_count are lifetime counters bumped directly by the desktop app
  // at the moment an analysis/export completes; last_active_at above is
  // reused (not new) for the ~75s heartbeat.
  videos_analyzed_count: number | null;
  last_analysis_at: string | null;
  exports_count: number | null;
  last_export_at: string | null;
  // Set only by a deliberate app close (migration 017's mark_offline RPC),
  // never by the heartbeat - lets isOnline() in UsersTable.tsx show
  // Inactive within seconds of a real quit instead of waiting out the
  // 2-minute heartbeat timeout. Stays stale (harmless) after a crash or
  // force-quit, since there's no closeEvent to call mark_offline from -
  // the 2-minute timeout is still what covers that case.
  last_explicit_close_at: string | null;
  social_accounts: SocialAccount[] | null;
  // Per-person daily export limit (migration 027) - a sub-limit within the
  // total credit balance, not a separate currency. daily_limit of 0 is the
  // new-person default (blocked until the founder sets a real limit).
  // daily_used/daily_bonus/daily_reset_at reflect the server's last lazy
  // reset, same staleness caveat as every other field here.
  daily_limit: number;
  daily_used: number;
  daily_bonus: number;
  daily_reset_at: string;
  // joined
  license_status: LicenseStatus | null;
  clip_count_30d: number;
  total_earnings: number;
}

// ── Campaign-based automatic hooks (migration 027) ──────────────────────────

export type CampaignHookStatus = "available" | "reserved" | "claimed";

// ── Content marketplace pivot (migration 028) ────────────────────────────────
// Campaigns stopped being per-person assigned: the founder now uploads and
// analyzes every video himself, from this dashboard, and every campaign is
// open to every user at all times (see CampaignVideo/CampaignClip below).

export type CampaignContentType = "gaming" | "podcast" | "vlog";
export type CampaignStatus = "active" | "paused" | "deleted"; // soft-delete

export interface Campaign {
  id: string;
  name: string;
  content_type: CampaignContentType;
  terms_text: string;
  status: CampaignStatus;
  created_at: string;
  // Computed by fetchCampaigns() from campaign_hooks, not a real column.
  total_hooks: number;
  available_hooks: number;
  claimed_hooks: number;
}

export interface CampaignHook {
  id: string;
  campaign_id: string;
  text: string;
  status: CampaignHookStatus;
  claimed_by_hwid: string | null;
  claimed_by_user_id: string | null;
  claimed_by_email: string | null;  // joined from users, for display
  claimed_at: string | null;
  created_at: string;
}

// Lightweight row shape used purely to drive live hook-pool counts on the
// dashboard (migration 029's anon Realtime grant on campaign_hooks is
// exactly these 4 columns - text stays server-only-readable). See
// lib/queries.ts's fetchCampaignHookStatuses and CampaignsPanel.tsx's
// `campaign_hooks` UPDATE subscription.
export interface CampaignHookStatusRow {
  id: string;
  campaign_id: string;
  status: CampaignHookStatus;
}

export type CampaignVideoStatus = "pending" | "claimed" | "analyzing" | "done" | "failed";

// One row per founder-uploaded source video; also the desktop worker-pool's
// job queue (claimed/analyzing are worker-owned states - the dashboard only
// ever sets 'pending' on upload/retry, never those two).
export interface CampaignVideo {
  id: string;
  campaign_id: string;
  original_filename: string;
  storage_path: string;
  status: CampaignVideoStatus;
  claimed_by_hwid: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  progress_fraction: number;
  progress_message: string | null;
  error_message: string | null;
  duration_seconds: number | null;
  created_at: string;
  completed_at: string | null;
}

// One row per produced clip, PLAIN - no hook burned (that happens per-user,
// client-side, at export time).
export interface CampaignClip {
  id: string;
  campaign_video_id: string;
  campaign_id: string;
  storage_path: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  created_at: string;
}

// One row per campaign open + T&C acceptance (re-shown/re-logged every open,
// not just first time) - doubles as the "who has agreed to this campaign's
// terms" compliance record.
export interface CampaignTermsLogRow {
  id: string;
  campaign_id: string;
  user_id: string | null;
  hwid: string;
  accepted_at: string;
  user_email: string | null; // joined from users, for display
}

export interface CampaignCompliance {
  openedCount: number;   // distinct user_id/hwid in campaign_terms_log
  exportedCount: number; // COUNT(*) of campaign_exports
  log: CampaignTermsLogRow[];
}

export interface PendingUser {
  id: string;
  hwid: string;
  full_name: string | null;
  whop_username: string | null;
  social_accounts: SocialAccount[] | null;
  gemini_key_hint: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}

export interface ClipRow {
  id: string;
  hwid: string | null;
  user_email: string | null;
  created_at: string;
  status: string | null;
  earnings: number | null;
}

export type SubmissionPlatform = "youtube" | "instagram" | "tiktok";
// Review/verification lifecycle only - payment itself is tracked on
// clips.payout_status via the Earnings page, and only there (see
// supabase/migrations/009_video_submissions.sql for why "paid" was
// removed from here).
export type SubmissionStatus = "pending_review" | "verified" | "disputed";

export interface SubmissionRow {
  id: string;
  user_id: string;
  hardware_id: string;
  user_email: string | null;
  platform: SubmissionPlatform;
  video_url: string;
  username: string;
  status: SubmissionStatus;
  whop_confirmed: boolean;
  submitted_at: string;
  updated_at: string;
}

export interface EarningsUserRow {
  hwid: string;
  user_email: string | null;
  gross_earnings: number;
  user_share: number;          // see USER_SHARE in lib/constants.ts
  admin_share: number;         // see ADMIN_SHARE in lib/constants.ts
  pending_user_share: number;  // portion of user_share not yet marked paid
  paid_user_share: number;     // portion of user_share already marked paid
  published_clips: number;
  fully_paid: boolean;         // true when pending_user_share is 0
}

export interface MonthlyBar {
  month: string;        // "2025-01"
  label: string;        // "Jan"
  gross: number;
  user_share: number;
  admin_share: number;
}

export interface SummaryStats {
  total_users: number;
  active_today: number;
  total_clips: number;
  total_earnings: number;
}
