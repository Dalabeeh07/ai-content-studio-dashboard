import { BULK_MAX_IDS, BULK_MAX_ROWS } from "@/lib/telegram/config";
import { isUuid, sanitizeFilters, validIso, type BulkScope } from "./filters";
import { applyFilters, buildFilterContext, type Db } from "./query";

// The logic behind app/submissions/actions.ts, with NO Next.js dependencies
// (no cookies(), no revalidatePath) so it can be exercised directly against a
// real database in tests. The server actions add exactly two things around
// it: the admin-session check and revalidatePath.
//
// Rules every function here follows:
//   * the scope is re-validated from scratch - the client is never trusted;
//   * real affected-row counts are checked. A Supabase update that matches
//     nothing returns NO error, and this project has shipped "silent success
//     on 0 rows" bugs before, so 0 rows is reported honestly;
//   * a "select all matching" scope is pinned to an `asOf` snapshot AND an
//     expected count: rows that arrived after the founder looked, or a set
//     that changed underneath him, are refused rather than swept in.

export interface BulkResult {
  ok: boolean;
  error?: string;
  /** rows actually changed */
  updated?: number;
  /** rows that were in scope (existed and matched) */
  matched?: number;
  /** exact whop_submitted_at stamp written - hand it back to undoWhop() */
  batch?: string;
  note?: string;
}

type Resolved =
  | { ok: true; apply: <T>(q: T, extra?: { pendingOnly?: boolean }) => T }
  | { ok: false; error: string };

export async function resolveScope(db: Db, scope: BulkScope): Promise<Resolved> {
  if (!scope || typeof scope !== "object") return { ok: false, error: "Invalid selection." };

  if (scope.mode === "ids") {
    if (!Array.isArray(scope.ids)) return { ok: false, error: "Invalid selection." };
    const ids = [...new Set(scope.ids)];
    if (ids.length === 0) return { ok: false, error: "Nothing selected." };
    if (ids.length > BULK_MAX_IDS) return { ok: false, error: `Too many rows selected (max ${BULK_MAX_IDS}); use "select all matching" instead.` };
    if (!ids.every(isUuid)) return { ok: false, error: "Invalid selection." };
    return {
      ok: true,
      apply: <T,>(q: T, extra?: { pendingOnly?: boolean }) => {
        type B = { in(c: string, v: string[]): B; is(c: string, v: null): B };
        let b = (q as unknown as B).in("id", ids);
        if (extra?.pendingOnly) b = b.is("whop_submitted_at", null);
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
      apply: <T,>(q: T, extra?: { pendingOnly?: boolean }) => applyFilters(q, filters, ctx, { asOf, pendingOnly: extra?.pendingOnly }),
    };
  }

  return { ok: false, error: "Invalid selection." };
}

async function countScope(db: Db, r: Extract<Resolved, { ok: true }>): Promise<{ n: number; error?: string }> {
  const { count, error } = await r.apply(db.from("video_submissions").select("id", { count: "exact", head: true }));
  return error ? { n: 0, error: error.message } : { n: count ?? 0 };
}

/**
 * Stamp whop_submitted_at on rows in scope that are still unmarked.
 * IDEMPOTENT: already-marked rows are never re-stamped (their original time
 * is kept), so running it twice changes nothing the second time. The exact
 * stamp is returned as `batch` so undoWhop() reverts precisely what THIS call
 * did and nothing else.
 */
export async function markWhop(db: Db, scope: BulkScope): Promise<BulkResult> {
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

  if (updated === 0) {
    return { ok: true, updated: 0, matched: matched.n, note: `All ${matched.n} were already marked as submitted - nothing changed.` };
  }
  return {
    ok: true, updated, matched: matched.n, batch,
    note: updated < matched.n ? `${matched.n - updated} of ${matched.n} were already marked and left as they were.` : undefined,
  };
}

/** Revert exactly one markWhop() call, identified by its batch stamp. */
export async function undoWhop(db: Db, batch: string): Promise<BulkResult> {
  const stamp = validIso(batch);
  if (!stamp) return { ok: false, error: "Invalid undo token." };
  const { count, error } = await db
    .from("video_submissions")
    .update({ whop_submitted_at: null, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("whop_submitted_at", stamp);
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: "Nothing to undo - those rows were already changed or unmarked." };
  return { ok: true, updated: count };
}

/** Clear whop_submitted_at on rows in scope, whatever stamp they carry. */
export async function unmarkWhop(db: Db, scope: BulkScope): Promise<BulkResult> {
  const r = await resolveScope(db, scope);
  if (!r.ok) return { ok: false, error: r.error };

  const matched = await countScope(db, r);
  if (matched.error) return { ok: false, error: matched.error };
  if (matched.n === 0) return { ok: false, error: "None of those rows exist any more - nothing was updated." };

  const { count, error } = await r.apply(
    db.from("video_submissions").update({ whop_submitted_at: null, updated_at: new Date().toISOString() }, { count: "exact" }),
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, updated: count ?? 0, matched: matched.n };
}

/** Assign (or clear, with null) the campaign of every row in scope. */
export async function assignCampaignCore(db: Db, scope: BulkScope, campaignId: string | null): Promise<BulkResult> {
  if (campaignId !== null && !isUuid(campaignId)) return { ok: false, error: "Invalid campaign." };

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
  if (!count) return { ok: false, error: "No rows were updated." };
  return { ok: true, updated: count, matched: matched.n };
}
