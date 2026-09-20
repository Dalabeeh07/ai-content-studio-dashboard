"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Create campaign ──────────────────────────────────────────────────────────

export async function createCampaign(name: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data, error } = await db
    .from("campaigns")
    .insert({ name: trimmed })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true, id: data?.id };
}

// ── Add hooks to a campaign's pool ───────────────────────────────────────────
//
// One hook text per line - matches how the founder will most naturally
// paste in a pre-written batch of hook lines at once (rule 1: "add hook
// text to a specific campaign's pool").

export async function addHooks(
  campaignId: string,
  rawText: string
): Promise<{ ok: boolean; added?: number; error?: string }> {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: "Enter at least one hook (one per line)." };

  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaign_hooks")
    .insert(lines.map((text) => ({ campaign_id: campaignId, text })));

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true, added: lines.length };
}

// ── Delete an unclaimed hook ─────────────────────────────────────────────────
//
// Only ever removes a row that is still 'available' - a claimed hook is
// permanent history (who got what), and a reserved one is mid-flight for a
// real export attempt, so deleting either from under the desktop app would
// be a real, harmful surprise for whoever is currently exporting with it.

export async function deleteHook(hookId: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaign_hooks")
    .delete()
    .eq("id", hookId)
    .eq("status", "available");

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true };
}
