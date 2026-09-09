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
  social_accounts: SocialAccount[] | null;
  // joined
  license_status: LicenseStatus | null;
  clip_count_30d: number;
  total_earnings: number;
}

export interface PendingUser {
  id: string;
  hwid: string;
  full_name: string | null;
  whop_username: string | null;
  license_key: string | null;
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
