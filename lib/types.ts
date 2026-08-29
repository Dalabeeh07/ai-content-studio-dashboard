export type LicenseStatus = "active" | "expired" | "revoked";

export interface UserRow {
  id: string;
  hardware_id: string;
  license_key: string | null;
  whop_username: string | null;
  social_usernames: Record<string, string>;
  created_at: string;
  last_active_at: string;
  // joined
  license_status: LicenseStatus | null;
  clip_count_30d: number;
  total_earnings: number;
}

export interface ClipRow {
  id: string;
  user_hardware_id: string | null;
  whop_username: string | null;
  filename: string;
  content_type: string;
  duration_sec: number | null;
  score: number | null;
  exported_at: string;
  published_url: string | null;
  platform: string | null;
  views: number | null;
  estimated_earnings_usd: number | null;
}

export interface EarningsUserRow {
  hardware_id: string;
  whop_username: string | null;
  total_views: number;
  gross_earnings: number;
  user_share: number;   // 60%
  admin_share: number;  // 40%
  published_clips: number;
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
