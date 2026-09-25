"use server";

import { revalidatePath } from "next/cache";
import { isAdminRequest, NOT_AUTHORIZED } from "@/lib/admin-auth";
import { BULK_MAX_IDS, BULK_MAX_ROWS } from "@/lib/telegram/config";
import { isUuid, sanitizeFilters, validIso, type BulkScope } from "@/lib/submissions/filters";
import { applyFilters, buildFilterContext, type Db } from "@/lib/submissions/query";
import { serverClient } from "@/lib/supabase";
import type { SubmissionStatus } from "@/lib/types";

// EVERY action here re-verifies the admin session (isAdminRequest) instead of
// relying only on proxy.ts, validates its input from scratch (the client is
// never trusted - filters are re-parsed with sanitizeFilters, ids must be
// uuids), and checks real affected-row counts: a Supabase update that
// matches nothing returns no error, and this project has shipped
// "silent success on 0 rows" bugs before (see revokeLicense).

export interface BulkResult {
  ok: boolean;
  error?: string;
  /** rows actually changed */
  updated?: number;
  /** rows that were in scope (existed and matched) */
  matched?: number;
  /** exact whop_submitted_at stamp written - hand it back to undoWhopSubmitted */
  batch?: string;
  note?: string;
}

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

// ── Bulk scope resolution ────────────────────────────────────────────────────

type Resolved =
  | { ok: true; apply: <T>(q: T, extra?: { pendingOnly?: boolean }) => T; description: string }
  | { ok: false; error: string };

/**
 * Turns a client-sent scope into a function that constrains ANY query to it.
 * ids: 1..BULK_MAX_IDS distinct uuids.
 * filter: re-sanitised filters + an `asOf` snapshot cutoff + the count the
 * founder was looking at. If the live count differs, the action REFUSES
 * rather than sweep in rows he never saw.
 */
async function resolveScope(db: Db, scope: BulkScope): Promise<Resolved> {
  if (!scope || typeof scope !== "object") return { ok: false, error: "Invalid selection." };

  if (scope.mode === "ids") {
    if (!Array.isArray(scope.ids)) return { ok: false, error: "Invalid selection." };
    const ids = [...new Set(scope.ids)];
    if (ids.length === 0) return { ok: false, error: "Nothing selected." };
    if (ids.length > BULK_MAX_IDS) return { ok: false, error: `Too many rows selected (max ${BULK_MAX_IDS}); use "select all matching" instead.` };
    if (!ids.every(isUuid)) return { ok: false, error: "Invalid selection." };
    return {
      ok: true,
      description: `${ids.length} selected row(s)`,
      apply: <T,>(q: T, extra?: { pendingOnly?: boolean }) => {
        let b = (q as unknown as { in(c: string, v: string[]): unknown }).in("id", ids) as unknown as { is(c: string, v: null): unknown };
        if (extra?.pendingOnly) b = b.is("whop_submitted_at", null) as unknown as typeof b;
        return b as unknown as T;
      },
    };
  }

  if (scope.mode === "filter") {
    const asOf = validIso(scope.asOf);
    if (!asOf) return { ok: false, error: "Invalid snapshot time - refresh the page and try again." };
    if (new Date(asOf).getTime() > Date.now() + 60_000) return { ok: false, error: "Invalid snapshot time." };
    const filters = sanitizeFilters(scope.filters as unknown as Record<string, unknown>);
    const ctx = await buildFilterContext(db, filters);

    const { count, error } = await applyFilters(
      db.from("video_submissions").select("id", { count: "exact", head: true }), filters, ctx, { asOf },
    );
    if (error) return { ok: false, error: error.message };
    const live = count ?? 0;
    if (!Number.isInteger(scope.expectedCount) || live !== scope.expectedCount) {
      return { ok: false, error: `The matching set changed (${live} now vs ${scope.expectedCount} when you selected). Refresh and try again - nothing was changed.` };
    }
    if (live === 0) return { ok: false, error: "No rows match - nothing to do." };
    if (live > BULK_MAX_ROWS) return { ok: false, error: `Too many rows (${live}); narrow the filters to at most ${BULK_MAX_ROWS.toLocaleString()}.` };
    return {
      ok: true,
      description: `${live} matching row(s)`,
      apply: <T,>(q: T, extra?: { pendingOnly?: boolean }) => applyFilters(q, filters, ctx, { asOf, pendingOnly: extra?.pendingOnly }),
    };
  }

  return { ok: false, error: "Invalid selection." };
}

async function countScope(db: Db, r: Extract<Resolved, { ok: true }>, extra?: { pendingOnly?: boolean }): Promise<{ n: number; error?: string }> {
  const { count, error } = await r.apply(db.from("video_submissions").select("id", { count: "exact", head: true }), extra);
  return error ? { n: 0, error: error.message } : { n: count ?? 0 };
}

// ── Mark / unmark "submitted to Whop" ───────────────────────────────────────

/**
 * Stamp whop_submitted_at on rows in scope that are still unmarked.
 * IDEMPOTENT: already-marked rows are never re-stamped (their original time
 * is kept), so running it twice changes nothing the second time. The exact
 * stamp is returned as `batch` so undoWhopSubmitted() reverts precisely what
 * THIS call did and nothing else.
 */
export async function markWhopSubmitted(scope: BulkScope): Promise<BulkResult> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const r = await resolveScope(db, scope);
  if (!r.ok) return { ok: false, error: r.error };

  const matched = await countScope(db, r);
  if (matched.error) return { ok: false, error: matched.error };
  if (matched.n === 0) return { ok: false, error: "None of those rows exist any more - nothing was updated." };

  const batch = new Date().toISOString();
  const { count, error } = await r.apply(
    db.from("video_submissions").update({ whop_submitted_at: batch, updated_at: batch }, { count: "exact" }),
    { pendingOnly: true },
  );
  if (error) return { ok: false, error: error.message };
  const updated = count ?? 0;

  revalidatePath("/submissions");
  if (updated === 0) {
    return { ok: true, updated: 0, matched: matched.n, note: `All ${matched.n} were already marked as submitted - nothing changed.` };
  }
  return { ok: true, updated, matched: matched.n, batch, note: updated < matched.n ? `${matched.n - updated} of ${matched.n} were already marked and left as they were.` : undefined };
}

/** Revert exactly one markWhopSubmitted() call, identified by its batch stamp. */
export async function undoWhopSubmitted(batch: string): Promise<BulkResult> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  const stamp = validIso(batch);
  if (!stamp) return { ok: false, error: "Invalid undo token." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { count, error } = await db
    .from("video_submissions")
    .update({ whop_submitted_at: null, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("whop_submitted_at", stamp);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/submissions");
  if (!count) return { ok: false, error: "Nothing to undo - those rows were already changed or unmarked." };
  return { ok: true, updated: count };
}

/** Clear whop_submitted_at on rows in scope, whatever stamp they carry. */
export async function unmarkWhopSubmitted(scope: BulkScope): Promise<BulkResult> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const r = await resolveScope(db, scope);
  if (!r.ok) return { ok: false, error: r.error };

  const matched = await countScope(db, r);
  if (matched.error) return { ok: false, error: matched.error };
  if (matched.n === 0) return { ok: false, error: "None of those rows exist any more - nothing was updated." };

  const { count, error } = await r.apply(
    db.from("video_submissions").update({ whop_submitted_at: null, updated_at: new Date().toISOString() }, { count: "exact" }),
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/submissions");
  return { ok: true, updated: count ?? 0, matched: matched.n };
}

// ── Campaign assignment ─────────────────────────────────────────────────────

/** Assign (or clear, with null) the campaign of every row in scope. */
export async function assignCampaign(scope: BulkScope, campaignId: string | null): Promise<BulkResult> {
  if (!(await isAdminRequest())) return { ok: false, error: NOT_AUTHORIZED };
  if (campaignId !== null && !isUuid(campaignId)) return { ok: false, error: "Invalid campaign." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  if (campaignId !== null) {
    const { data, error } = await db.from("campaigns").select("id").eq("id", campaignId).neq("status", "deleted").maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "That campaign no longer exists." };
  }

  const r = await resolveScope(db, scope);
  if (!r.ok) return { ok: false, error: r.error };

  const matched = await countScope(db, r);
  if (matched.error) return { ok: false, error: matched.error };
  if (matched.n === 0) return { ok: false, error: "None of those rows exist any more - nothing was updated." };

  const { count, error } = await r.apply(
    db.from("video_submissions").update({ campaign_id: campaignId, updated_at: new Date().toISOString() }, { count: "exact" }),
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/submissions");
  if (!count) return { ok: false, error: "No rows were updated." };
  return { ok: true, updated: count, matched: matched.n };
}
