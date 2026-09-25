"use server";

import { revalidatePath } from "next/cache";
import { isAdminRequest, NOT_AUTHORIZED } from "@/lib/admin-auth";
import { assignCampaignCore, markWhop, undoWhop, unmarkWhop, type BulkResult } from "@/lib/submissions/bulk";
import { isUuid, type BulkScope } from "@/lib/submissions/filters";
import { serverClient } from "@/lib/supabase";
import type { SubmissionStatus } from "@/lib/types";

// Every action re-verifies the admin session (isAdminRequest) instead of
// relying only on proxy.ts: a Server Action is reachable by a plain POST and
// is a security boundary in its own right. The bulk logic itself (scope
// validation, snapshot/expected-count guard, real row-count checks) lives in
// lib/submissions/bulk.ts so it can be tested against a real database; these
// wrappers add ONLY the auth check and revalidatePath.

export type { BulkResult };

type Simple = { ok: boolean; error?: string };

// ── Status / Whop-confirmed (single row) ────────────────────────────────────

// Review/verification lifecycle only - "paid" was removed from
// SubmissionStatus entirely (see lib/types.ts); payment is tracked on
// clips.payout_status via the Earnings page instead.
const VALID_STATUSES: SubmissionStatus[] = ["pending_review", "verified", "disputed"];

export async function updateSubmissionStatus(id: string, status: SubmissionStatus): Promise<Simple> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (!isUuid(id)) return { ok: false, error: "Invalid submission id." };
  if (!VALID_STATUSES.includes(status)) return { ok: false, error: `Invalid status: ${status}` };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  // A Supabase update that matches no row returns no error - select the id
  // back so "not found" is reported instead of a silent success.
  const { data, error } = await db
    .from("video_submissions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "Submission not found - nothing was updated." };
  revalidatePath("/submissions");
  return { ok: true };
}

export async function setWhopConfirmed(id: string, confirmed: boolean): Promise<Simple> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (!isUuid(id)) return { ok: false, error: "Invalid submission id." };
  if (typeof confirmed !== "boolean") return { ok: false, error: "Invalid value." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data, error } = await db
    .from("video_submissions")
    .update({ whop_confirmed: confirmed, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "Submission not found - nothing was updated." };
  revalidatePath("/submissions");
  return { ok: true };
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

async function guarded<T extends { ok: boolean }>(run: (db: NonNullable<ReturnType<typeof serverClient>>) => Promise<T>): Promise<T | { ok: false; error: string }> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const r = await run(db);
  if (r.ok) revalidatePath("/submissions");
  return r;
}

/** Stamp whop_submitted_at on unmarked rows in scope (idempotent). */
export async function markWhopSubmitted(scope: BulkScope): Promise<BulkResult> {
  return guarded((db) => markWhop(db, scope));
}

/** Revert exactly one markWhopSubmitted() call, identified by its batch stamp. */
export async function undoWhopSubmitted(batch: string): Promise<BulkResult> {
  return guarded((db) => undoWhop(db, batch));
}

/** Clear whop_submitted_at on rows in scope, whatever stamp they carry. */
export async function unmarkWhopSubmitted(scope: BulkScope): Promise<BulkResult> {
  return guarded((db) => unmarkWhop(db, scope));
}

/** Assign (or clear, with null) the campaign of every row in scope. */
export async function assignCampaign(scope: BulkScope, campaignId: string | null): Promise<BulkResult> {
  return guarded((db) => assignCampaignCore(db, scope, campaignId));
}
