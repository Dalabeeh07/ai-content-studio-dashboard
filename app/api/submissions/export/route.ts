import { NextRequest } from "next/server";
import { isAdminRequest, NOT_AUTHORIZED } from "@/lib/admin-auth";
import { EXPORT_CHUNK, EXPORT_MAX_ROWS } from "@/lib/telegram/config";
import { csvHeaderLine, csvLine, TxtGrouper, type ExportRow } from "@/lib/submissions/export";
import { sanitizeFilters, validIso } from "@/lib/submissions/filters";
import { applyFilters, buildFilterContext } from "@/lib/submissions/query";
import { serverClient } from "@/lib/supabase";

// Streaming CSV / plain-text export for the founder's Whop workflow.
//
//   GET /api/submissions/export?format=csv|txt&<same filters as the page>
//       [&pending=1]   force "not yet hand-submitted to Whop" (Telegram rows unless source is set)
//       [&headers=1]   txt only: "# Campaign - platform" comment lines
//       [&asOf=ISO]    snapshot cutoff (rows submitted after it are excluded)
//
// Ordered campaign name -> platform -> oldest first (Whop is submitted per
// campaign, so each group is a paste batch; unassigned links come last).
// Rows are fetched in EXPORT_CHUNK pages and streamed, so a 10k-row export
// never buffers the table and never approaches the function timeout; a hard
// cap (EXPORT_MAX_ROWS) bounds the worst case and is reported up front in
// X-Export-* headers. A failure mid-stream ABORTS the response - a broken
// download is honest, a silently short file is not.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SELECT =
  "id, platform, video_url, canonical_url, hardware_id, submitted_at, status, whop_submitted_at, " +
  "source, flags, telegram_user_id, users(email)";

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest())) {
    return Response.json({ error: NOT_AUTHORIZED }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const db = serverClient();
  if (!db) return Response.json({ error: "Server not configured." }, { status: 503 });

  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") === "txt" ? "txt" : "csv";
  const filters = sanitizeFilters(Object.fromEntries(sp.entries()));
  const pendingOnly = sp.get("pending") === "1";
  // "Pending for Whop" is a Telegram-intake concept: desktop-app rows were
  // already submitted to Whop by the creators themselves (migration 009), so
  // an unfiltered pending export means Telegram rows only.
  if (pendingOnly && filters.source === "all") filters.source = "telegram";
  const withHeaders = sp.get("headers") === "1";
  const asOf = validIso(sp.get("asOf")) ?? new Date().toISOString();
  const opts = { asOf, pendingOnly };

  const ctx = await buildFilterContext(db, filters);

  const { count, error: countErr } = await applyFilters(
    db.from("video_submissions").select("id", { count: "exact", head: true }), filters, ctx, opts,
  );
  if (countErr) return Response.json({ error: countErr.message }, { status: 500 });
  const total = count ?? 0;

  // Groups in the order they will be emitted: campaigns by name, unassigned last.
  const { data: camps, error: campErr } = await db.from("campaigns").select("id, name").order("name", { ascending: true }).limit(1000);
  if (campErr) return Response.json({ error: campErr.message }, { status: 500 });
  let groups: { id: string | null; name: string | null }[] = [
    ...(camps ?? []).map((c) => ({ id: c.id as string, name: c.name as string })),
    { id: null, name: null },
  ];
  if (filters.campaign === "none") groups = [{ id: null, name: null }];
  else if (filters.campaign !== "all") groups = groups.filter((g) => g.id === filters.campaign);

  const tgNames = new Map<number, string | null>();
  async function resolveTelegram(ids: number[]) {
    const missing = [...new Set(ids)].filter((i) => !tgNames.has(i));
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const { data } = await db!.from("telegram_users").select("telegram_user_id, username").in("telegram_user_id", batch);
      for (const t of data ?? []) tgNames.set(Number(t.telegram_user_id), (t.username as string | null) ?? null);
      for (const id of batch) if (!tgNames.has(id)) tgNames.set(id, null);
    }
  }

  const enc = new TextEncoder();
  let started = false;
  let gi = 0;
  let offset = 0;
  let emitted = 0;
  const grouper = new TxtGrouper(withHeaders);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (format === "csv") {
            controller.enqueue(enc.encode(`﻿${csvHeaderLine()}\r\n`)); // BOM: Excel reads the Arabic names as UTF-8
            return;
          }
        }
        while (gi < groups.length && emitted < EXPORT_MAX_ROWS) {
          const g = groups[gi];
          const want = Math.min(EXPORT_CHUNK, EXPORT_MAX_ROWS - emitted);
          let q = applyFilters(db.from("video_submissions").select(SELECT), filters, ctx, opts);
          q = g.id === null ? q.is("campaign_id", null) : q.eq("campaign_id", g.id);
          const { data, error } = await q
            .order("platform", { ascending: true })
            .order("submitted_at", { ascending: true })
            .order("id", { ascending: true })
            .range(offset, offset + want - 1);
          if (error) throw new Error(error.message);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = (data ?? []) as any[];
          if (rows.length === 0) { gi++; offset = 0; continue; }

          await resolveTelegram(rows.map((r) => r.telegram_user_id).filter((x) => x != null).map(Number));
          const out: ExportRow[] = rows.map((r) => {
            const u = Array.isArray(r.users) ? r.users[0] : r.users;
            const tg = r.telegram_user_id == null ? null : (tgNames.get(Number(r.telegram_user_id)) ? `@${tgNames.get(Number(r.telegram_user_id))}` : String(r.telegram_user_id));
            return {
              campaign: g.name, platform: r.platform, url: r.video_url, canonicalUrl: r.canonical_url ?? null,
              userEmail: (u as { email: string | null } | null)?.email ?? null, hwid: r.hardware_id, telegram: tg,
              submittedAt: r.submitted_at, status: r.status, whopSubmittedAt: r.whop_submitted_at ?? null,
              source: r.source ?? "app", flags: Array.isArray(r.flags) ? r.flags : [],
            };
          });

          const text = format === "csv" ? out.map(csvLine).join("\r\n") + "\r\n" : grouper.chunk(out);

          controller.enqueue(enc.encode(text));
          emitted += rows.length;
          offset += rows.length;
          if (rows.length < want) { gi++; offset = 0; }
          return; // one chunk per pull: honours backpressure
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const headers: Record<string, string> = {
    "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Export-Total": String(total),
    "X-Export-Count": String(Math.min(total, EXPORT_MAX_ROWS)),
    "X-Export-Truncated": total > EXPORT_MAX_ROWS ? "1" : "0",
    "X-Export-AsOf": asOf,
  };
  if (format === "csv" || sp.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="submissions-${stamp}.${format}"`;
  }
  return new Response(stream, { headers });
}
