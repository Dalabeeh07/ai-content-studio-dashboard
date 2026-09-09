"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";
import type { SubmissionStatus } from "@/lib/types";

// Review/verification lifecycle only - "paid" was removed from
// SubmissionStatus entirely (see lib/types.ts); payment is tracked on
// clips.payout_status via the Earnings page instead.
const VALID_STATUSES: SubmissionStatus[] = ["pending_review", "verified", "disputed"];

// ── Update status ─────────────────────────────────────────────────────────────

export async function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus
): Promise<{ ok: boolean; error?: string }> {
  if (!VALID_STATUSES.includes(status)) {
    return { ok: false, error: `Invalid status: ${status}` };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("video_submissions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/submissions");
  return { ok: true };
}

// ── Toggle Whop-side confirmation ───────────────────────────────────────────────

export async function setWhopConfirmed(
  id: string,
  confirmed: boolean
): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("video_submissions")
    .update({ whop_confirmed: confirmed, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/submissions");
  return { ok: true };
}
