export type LicenseStatus = "active" | "expired" | "revoked";

export interface UserRow {
  id: string;
  hwid: string;
  email: string | null;
  license_key: string | null;
  status: string | null;
  created_at: string;
  last_active_at: string | null;
  whop_earnings: number | null;
  clips_count: number | null;
  // joined
  license_status: LicenseStatus | null;
  clip_count_30d: number;
  total_earnings: number;
}

export interface ClipRow {
  id: string;
  hwid: string | null;
  user_email: string | null;
  created_at: string;
  status: string | null;
  earnings: number | null;
}

export interface EarningsUserRow {
  hwid: string;
  user_email: string | null;
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
