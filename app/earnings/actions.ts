"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Mark a user's outstanding balance as paid ───────────────────────────────
// Bulk by design: the earnings page aggregates per user, not per clip, so
// "mark paid" clears every currently-pending clip for that hwid in one action.

export async function markUserPaid(hwid: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("clips")
    .update({ payout_status: "paid" })
    .eq("hwid", hwid)
    .neq("payout_status", "paid");

  if (error) return { ok: false, error: error.message };
  revalidatePath("/earnings");
  return { ok: true };
}

// ── Undo: reset a user's clips back to pending ──────────────────────────────
// For correcting a mistaken "mark paid" click - affects all of that user's
// clips, symmetric with markUserPaid.

export async function markUserPending(hwid: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("clips")
    .update({ payout_status: "pending" })
    .eq("hwid", hwid);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/earnings");
  return { ok: true };
}
