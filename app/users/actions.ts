"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Campaign assignment (migration 027) ─────────────────────────────────────

export async function assignCampaign(
  userId: string,
  campaignId: string | null
): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("users")
    .update({ campaign_id: campaignId })
    .eq("id", userId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/users");
  return { ok: true };
}

// ── Daily export limit (migration 027) ──────────────────────────────────────
//
// Rule 2: new-person default is 0 (blocked) until the founder explicitly
// sets a real limit here - this action is the only way that ever changes.

export async function updateDailyLimit(
  userId: string,
  limit: number
): Promise<{ ok: boolean; error?: string }> {
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
