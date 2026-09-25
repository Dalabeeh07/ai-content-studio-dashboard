"use server";

import { revalidatePath } from "next/cache";
import { isAdminRequest, NOT_AUTHORIZED } from "@/lib/admin-auth";
import { isUuid } from "@/lib/submissions/filters";
import { serverClient } from "@/lib/supabase";
import { formatLinkCode, generateLinkCode, hashLinkCode } from "@/lib/telegram/codes";
import { BOT_USERNAME, LINK_CODE_TTL_SECONDS } from "@/lib/telegram/config";

// Campaign assignment (migration 027's assignCampaign) was removed by the
// content-marketplace pivot (migration 028) - campaigns are no longer
// per-person assigned, users.campaign_id no longer exists as a column, and
// every campaign is open to every user at all times. See
// components/campaigns/CampaignsPanel.tsx for the founder-facing side of
// that pivot.

// ── Daily export limit (migration 027) ──────────────────────────────────────
//
// Rule 2: new-person default is 0 (blocked) until the founder explicitly
// sets a real limit here - this action is the only way that ever changes.

export async function updateDailyLimit(
  userId: string,
  limit: number
): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    return { ok: false, error: "Daily limit must be an integer between 0 and 1000." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("users")
    .update({ daily_limit: limit })
    .eq("id", userId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/users");
  return { ok: true };
}

// ── One-time today-only bonus (rule 7) ──────────────────────────────────────
//
// Additive on top of whatever daily_bonus is already set for today (so
// granting +2 twice in one day gives +4 today, not a stomp) - and, per
// consume_daily_credit/get_daily_status's own lazy-reset logic, gets wiped
// back to 0 automatically at the next UTC midnight along with daily_used.
// This never changes daily_limit itself.

export async function grantDailyBonus(
  userId: string,
  bonus: number
): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (!Number.isInteger(bonus) || bonus < 1 || bonus > 100) {
    return { ok: false, error: "Bonus must be an integer between 1 and 100." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data: current, error: readErr } = await db
    .from("users")
    .select("daily_bonus")
    .eq("id", userId)
    .single();
  if (readErr) return { ok: false, error: readErr.message };

  const { error } = await db
    .from("users")
    .update({ daily_bonus: (current?.daily_bonus ?? 0) + bonus })
    .eq("id", userId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/users");
  return { ok: true };
}

// ── Telegram link codes (migration 041) ─────────────────────────────────────
//
// The founder generates a one-time code for a user; the user sends
// `/link CODE` to @PlovikaLinksBot. The code is shown to the founder ONCE:
// only its HMAC is stored (lib/telegram/codes.ts), so it cannot be shown
// again - generate a new one instead (which also invalidates the old one).

export interface LinkCodeResult {
  ok: boolean;
  error?: string;
  code?: string;       // display form, e.g. "K7QM-R2XP"
  expiresAt?: string;
  deepLink?: string;   // t.me link that pre-fills /start CODE
}

export async function generateTelegramLinkCode(userId: string): Promise<LinkCodeResult> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (!isUuid(userId)) return { ok: false, error: "Invalid user." };

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!secret) {
    return { ok: false, error: "TELEGRAM_WEBHOOK_SECRET is not set on the server - link codes cannot be created." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  // users.hwid is the populated column (every live row); hardware_id is the
  // legacy fallback - same resolution as fetchUsers().
  const { data: user, error: uErr } = await db.from("users").select("id, hwid, hardware_id").eq("id", userId).maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!user) return { ok: false, error: "User not found." };
  const hwid: string | null = user.hwid ?? user.hardware_id ?? null;
  if (!hwid) return { ok: false, error: "This user has no device ID yet, so a link code cannot be tied to them." };

  // A 40-bit random code colliding with an existing hash is astronomically
  // unlikely; retry on the unique violation anyway rather than surface it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateLinkCode();
    const { data, error } = await db.rpc("tg_create_link_code", {
      p_hwid: hwid, p_user_id: userId, p_code_hash: hashLinkCode(code, secret), p_ttl_seconds: LINK_CODE_TTL_SECONDS,
    });
    if (error) {
      if (error.code === "23505") continue;
      return { ok: false, error: error.message };
    }
    revalidatePath("/users");
    return {
      ok: true,
      code: formatLinkCode(code),
      expiresAt: typeof data === "string" ? data : new Date(Date.now() + LINK_CODE_TTL_SECONDS * 1000).toISOString(),
      deepLink: `https://t.me/${BOT_USERNAME}?start=${code}`,
    };
  }
  return { ok: false, error: "Could not generate a unique code - please try again." };
}

/** Revoke the active Telegram link AND any unused code for a user's device. */
export async function revokeTelegramLink(hwid: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (typeof hwid !== "string" || hwid.length === 0 || hwid.length > 256) return { ok: false, error: "Invalid device ID." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data, error } = await db.rpc("tg_revoke_link_admin", { p_hwid: hwid });
  if (error) return { ok: false, error: error.message };
  const r = (data ?? {}) as { links_revoked?: number; codes_revoked?: number };
  const links = r.links_revoked ?? 0;
  const codes = r.codes_revoked ?? 0;
  if (links + codes === 0) {
    return { ok: false, error: "Nothing to revoke - this user has no active Telegram link or pending code." };
  }
  revalidatePath("/users");
  return { ok: true, note: `${links} link(s) and ${codes} pending code(s) revoked.` };
}
