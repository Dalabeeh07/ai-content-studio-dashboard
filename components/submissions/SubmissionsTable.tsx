"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  assignCampaign, markWhopSubmitted, setWhopConfirmed, undoWhopSubmitted,
  unmarkWhopSubmitted, updateSubmissionStatus,
} from "@/app/submissions/actions";
import { copyTextToClipboard, useCopyToClipboard } from "@/components/CopyCell";
import { ToastStack, useToasts } from "@/components/Toast";
import { browserClient } from "@/lib/supabase";
import { playNotificationChime, unlockAudioOnNextInteraction, useSoundMuted } from "@/lib/sound";
import { sortForExport, txtFromOrderedRows } from "@/lib/submissions/export";
import { filtersToParams, type BulkScope, type SubmissionFilters } from "@/lib/submissions/filters";
import type { CampaignOption } from "@/lib/submissions/query";
import { DEFAULT_PAGE_SIZE, EXPORT_MAX_ROWS } from "@/lib/telegram/config";
import type { PendingCount, SubmissionRow, SubmissionStatus } from "@/lib/types";
import SubmissionsFilters from "./SubmissionsFilters";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", x: "X",
};

const STATUS_CFG: Record<SubmissionStatus, { cls: string; label: string }> = {
  pending_review: { cls: "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]", label: "Pending Review" },
  verified:       { cls: "bg-brand-blue/10 text-brand-blue border-brand-blue/30", label: "Verified" },
  disputed:       { cls: "bg-red-900/20 text-red-400 border-red-800/40", label: "Disputed" },
};

function StatusBadge({ status }: { status: SubmissionStatus }) {
  const { cls, label } = STATUS_CFG[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
      {label}
    </span>
  );
}

const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border";

function FlagChips({ row }: { row: SubmissionRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.flags.includes("duplicate_of_other_user") && (
        <span
          className={`${CHIP} bg-red-900/20 text-red-400 border-red-800/40`}
          title={
            "Another account also tried to submit this link:\n" +
            (row.dup_attempts.length ? row.dup_attempts.map((d) => `• ${d.who} (${fmtDateTime(d.at)})`).join("\n") : "(details unavailable)")
          }
        >
          ⚠ also sent by another user{row.dup_attempts.length > 1 ? ` ×${row.dup_attempts.length}` : ""}
        </span>
      )}
      {row.flags.includes("license_inactive") && (
        <span className={`${CHIP} bg-brand-orange/10 text-brand-orange border-brand-orange/30`} title="The sender's license was not active when this link arrived">
          license inactive
        </span>
      )}
      {row.flags.includes("short_link") && (
        <span className={`${CHIP} bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]`} title="Short/share link - stored as sent, never resolved server-side, so it is not de-duplicated against the full URL">
          short link
        </span>
      )}
    </div>
  );
}

// ── Link cell: openable link + a dedicated copy button ──────────────────────

function LinkCell({ url }: { url: string }) {
  const [state, copy] = useCopyToClipboard();
  const truncated = url.length > 46 ? `${url.slice(0, 46)}…` : url;
  // Desktop-app rows come through an anon-callable RPC that accepts ANY text as
  // the URL, so only http(s) values become clickable; anything else (e.g. a
  // "javascript:" string) is shown as inert text and can still be copied.
  const openable = /^https?:\/\//i.test(url);
  return (
    <div className="flex items-center gap-1.5">
      {openable ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline text-xs break-all" title={url}>
          {truncated}
        </a>
      ) : (
        <span className="text-[#7070a0] text-xs break-all" title={`${url} (not an http/https link - not clickable)`}>{truncated}</span>
      )}
      <button
        onClick={() => copy(url)}
        title="Copy link"
        className={`shrink-0 text-[10px] leading-none px-1.5 py-1 rounded border transition-colors
          ${state === "copied" ? "border-brand-mint/40 text-brand-mint"
            : state === "failed" ? "border-brand-orange/40 text-brand-orange"
            : "border-[#1e1e38] text-[#7070a0] hover:border-brand-blue hover:text-brand-blue"}`}
      >
        {state === "copied" ? "✓" : state === "failed" ? "✗" : "⧉"}
      </button>
    </div>
  );
}

// ── Row actions ────────────────────────────────────────────────────────────────

type Patch = Partial<Pick<SubmissionRow, "status" | "whop_confirmed" | "whop_submitted_at" | "campaign_id" | "campaign_name">>;

function RowActions({
  row, onPatch, onError, onDone,
}: {
  row: SubmissionRow;
  onPatch: (patch: Patch) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function setStatus(status: SubmissionStatus) {
    const prev = row.status;
    onPatch({ status });
    startTransition(async () => {
      const r = await updateSubmissionStatus(row.id, status);
      if (!r.ok) { onPatch({ status: prev }); onError(r.error ?? "Failed"); }
    });
  }

  function toggleWhopConfirmed() {
    const prev = row.whop_confirmed;
    onPatch({ whop_confirmed: !prev });
    startTransition(async () => {
      const r = await setWhopConfirmed(row.id, !prev);
      if (!r.ok) { onPatch({ whop_confirmed: prev }); onError(r.error ?? "Failed"); }
    });
  }

  function toggleSubmitted() {
    const prev = row.whop_submitted_at;
    onPatch({ whop_submitted_at: prev ? null : new Date().toISOString() });
    startTransition(async () => {
      const scope: BulkScope = { mode: "ids", ids: [row.id] };
      const r = prev ? await unmarkWhopSubmitted(scope) : await markWhopSubmitted(scope);
      if (!r.ok) { onPatch({ whop_submitted_at: prev }); onError(r.error ?? "Failed"); return; }
      onDone();
    });
  }

  const btnBase = "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {row.source === "telegram" && (
        <button
          onClick={toggleSubmitted}
          disabled={pending}
          title={row.whop_submitted_at ? "Click to unmark (not submitted to Whop yet)" : "Mark as submitted to Whop"}
          className={`${btnBase} ${row.whop_submitted_at
            ? "bg-[#0f2a1a] border-brand-mint/40 text-brand-mint"
            : "bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-mint hover:text-brand-mint"}`}
        >
          {row.whop_submitted_at ? "✓ Submitted to Whop" : "Mark submitted"}
        </button>
      )}
      <button
        onClick={toggleWhopConfirmed}
        disabled={pending}
        title="Toggle after you've manually checked the matching Whop submission exists"
        className={`${btnBase} ${row.whop_confirmed
          ? "bg-[#0f2a1a] border-brand-mint/40 text-brand-mint"
          : "bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-mint hover:text-brand-mint"}`}
      >
        {row.whop_confirmed ? "✓ Whop confirmed" : "Confirm on Whop"}
      </button>
      {row.status !== "verified" && (
        <button onClick={() => setStatus("verified")} disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-blue hover:border-brand-blue hover:bg-[#0f1a2a]`}>
          Mark Verified
        </button>
      )}
      {row.status !== "disputed" && (
        <button onClick={() => setStatus("disputed")} disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]`}>
          Mark Disputed
        </button>
      )}
      {row.status !== "pending_review" && (
        <button onClick={() => setStatus("pending_review")} disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-[#7070a0] hover:bg-[#1a1a2e]`}>
          Reset to Pending
        </button>
      )}
    </div>
  );
}

// ── Per-row campaign assignment (rows the bot could not attribute) ──────────

function CampaignCell({
  row, campaigns, onPatch, onError,
}: {
  row: SubmissionRow;
  campaigns: CampaignOption[];
  onPatch: (patch: Patch) => void;
  onError: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  if (row.campaign_id) {
    return <span className="text-[#e8e8f0] text-xs">{row.campaign_name ?? "(deleted campaign)"}</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className={`${CHIP} bg-brand-orange/10 text-brand-orange border-brand-orange/30 self-start`}>no campaign</span>
      {row.source === "telegram" && (
        <select
          disabled={pending}
          defaultValue=""
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            const c = campaigns.find((x) => x.id === id);
            onPatch({ campaign_id: id, campaign_name: c?.name ?? null });
            startTransition(async () => {
              const r = await assignCampaign({ mode: "ids", ids: [row.id] }, id);
              if (!r.ok) { onPatch({ campaign_id: null, campaign_name: null }); onError(r.error ?? "Failed"); }
            });
          }}
          className="bg-[#0f0f1c] border border-[#1e1e38] rounded px-1.5 py-1 text-[11px] text-[#7070a0] max-w-[150px] focus:outline-none focus:border-brand-blue"
        >
          <option value="">Assign…</option>
          {campaigns.filter((c) => c.status !== "deleted").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Sound mute toggle ────────────────────────────────────────────────────────

function SoundToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={muted ? "Unmute new-submission sound" : "Mute new-submission sound"}
      className="px-2.5 py-1.5 rounded-lg text-sm border border-[#1e1e38] text-[#7070a0] hover:border-brand-blue hover:text-brand-blue transition-colors"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface Props {
  rows: SubmissionRow[];
  total: number;
  page: number;
  size: number;
  /** snapshot instant the page (and its total) was computed at */
  asOf: string;
  filters: SubmissionFilters;
  campaigns: CampaignOption[];
  pending: PendingCount[];
}

const BTN = "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

export default function SubmissionsTable({ rows: initialRows, total, page, size, asOf, filters, campaigns, pending }: Props) {
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const [rows, setRows] = useState<SubmissionRow[]>(initialRows);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [groupHeaders, setGroupHeaders] = useState(true);
  const [assignTarget, setAssignTarget] = useState("");
  const [muted, toggleMuted] = useSoundMuted();
  const { toasts, push, dismiss } = useToasts();

  // Same "reset state when the prop changes" pattern as UsersTable: a new
  // server render replaces local state (and clears the selection and the
  // new-rows banner) instead of being shadowed by stale local edits.
  const [lastSeen, setLastSeen] = useState(initialRows);
  if (initialRows !== lastSeen) {
    setLastSeen(initialRows);
    setRows(initialRows);
    setSelected(new Set());
    setAllMatching(false);
    setNewCount(0);
  }

  // Realtime callback closure must see the current mute flag without resubscribing.
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { unlockAudioOnNextInteraction(); }, []);
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
  }, []);

  // Live INSERTs (migration 024's anon grant; `select` restricts the payload to
  // exactly the granted columns). With server-side pagination a new row can
  // not be spliced into the list without breaking page boundaries and the
  // total, so a live insert raises a banner ("N new - refresh") instead.
  useEffect(() => {
    const channel = browserClient
      .channel("submissions-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT", schema: "public", table: "video_submissions",
          select: ["id", "hardware_id", "platform", "video_url", "username", "status", "submitted_at", "whop_confirmed"],
        },
        (payload) => {
          const ins = payload.new as { id: string; username: string; platform: string };
          setNewCount((n) => n + 1);
          const label = PLATFORM_LABELS[ins.platform] ?? ins.platform;
          push(`New submission: @${ins.username} (${label})`, "success");
          if (!mutedRef.current) playNotificationChime();
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            try {
              const n = new Notification("New video submission", { body: `@${ins.username} submitted a ${label} link`, tag: `submission-${ins.id}` });
              n.onclick = () => { window.focus(); n.close(); };
            } catch { /* the in-page toast already covers this */ }
          }
        },
      )
      .subscribe();
    return () => { browserClient.removeChannel(channel); };
  }, [push]);

  // ── Navigation (filters + pagination live in the URL) ──
  const go = (f: SubmissionFilters, p: number, s: number) => {
    const params = filtersToParams(f);
    if (p > 1) params.set("page", String(p));
    if (s !== DEFAULT_PAGE_SIZE) params.set("size", String(s));
    const qs = params.toString();
    startNav(() => router.push(qs ? `/submissions?${qs}` : "/submissions"));
  };
  const refresh = () => startNav(() => router.refresh());

  const pageCount = Math.max(1, Math.ceil(total / size));
  const patchRow = (id: string, patch: Patch) => setRows((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  // ── Selection ──
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectionCount = allMatching ? total : selected.size;
  const toggleAll = () => {
    setAllMatching(false);
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };
  const toggleOne = (id: string) => {
    setAllMatching(false);
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const scope = (): BulkScope | null =>
    allMatching ? { mode: "filter", filters, asOf, expectedCount: total }
    : selected.size > 0 ? { mode: "ids", ids: [...selected] }
    : null;

  // ── Bulk actions ──
  async function undo(batch: string) {
    setBusy(true);
    const r = await undoWhopSubmitted(batch);
    setBusy(false);
    if (!r.ok) { push(r.error ?? "Undo failed", "error"); return; }
    push(`Undone: ${r.updated} row(s) are pending again.`, "success");
    refresh();
  }

  async function bulkMark() {
    const sc = scope();
    if (!sc) return;
    setBusy(true);
    const r = await markWhopSubmitted(sc);
    setBusy(false);
    if (!r.ok) { push(r.error ?? "Failed", "error"); return; }
    if (!r.updated) { push(r.note ?? "Nothing changed.", "info"); return; }
    push(
      `Marked ${r.updated} link(s) as submitted to Whop.${r.note ? ` ${r.note}` : ""}`,
      "success",
      r.batch ? { label: "Undo", onClick: () => void undo(r.batch as string) } : undefined,
    );
    refresh();
  }

  async function bulkUnmark() {
    const sc = scope();
    if (!sc) return;
    setBusy(true);
    const r = await unmarkWhopSubmitted(sc);
    setBusy(false);
    if (!r.ok) { push(r.error ?? "Failed", "error"); return; }
    push(`Unmarked ${r.updated} row(s).`, "success");
    refresh();
  }

  async function bulkAssign() {
    const sc = scope();
    if (!sc || !assignTarget) return;
    setBusy(true);
    const r = await assignCampaign(sc, assignTarget === "__none__" ? null : assignTarget);
    setBusy(false);
    if (!r.ok) { push(r.error ?? "Failed", "error"); return; }
    push(`Campaign updated on ${r.updated} row(s).`, "success");
    setAssignTarget("");
    refresh();
  }

  function exportParams(extra: Record<string, string> = {}): URLSearchParams {
    const p = filtersToParams(filters);
    p.set("asOf", asOf);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  async function copyFromServer(extra: Record<string, string>, what: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/submissions/export?${exportParams({ format: "txt", ...extra })}`, { cache: "no-store" });
      if (!res.ok) { push(`Export failed (${res.status}).`, "error"); return; }
      const text = await res.text();
      const count = Number(res.headers.get("X-Export-Count") ?? "0");
      const truncated = res.headers.get("X-Export-Truncated") === "1";
      if (count === 0 || text.trim() === "") { push(`No ${what} to copy.`, "info"); return; }
      const ok = await copyTextToClipboard(text);
      if (!ok) { push("The browser refused clipboard access - use Export CSV instead.", "error"); return; }
      push(
        `Copied ${count.toLocaleString()} ${what}, grouped by campaign then platform.${truncated ? ` Capped at ${EXPORT_MAX_ROWS.toLocaleString()} - narrow the filters for the rest.` : ""}`,
        truncated ? "info" : "success",
      );
    } catch {
      push("Export failed (network error).", "error");
    } finally {
      setBusy(false);
    }
  }

  async function copySelection() {
    if (allMatching) { await copyFromServer({}, "matching links"); return; }
    const chosen = rows.filter((r) => selected.has(r.id));
    if (chosen.length === 0) return;
    const ordered = sortForExport(chosen.map((r) => ({
      campaign: r.campaign_name, platform: r.platform, url: r.video_url, submittedAt: r.submitted_at,
    })));
    const ok = await copyTextToClipboard(txtFromOrderedRows(ordered, groupHeaders));
    push(ok ? `Copied ${chosen.length} link(s).` : "The browser refused clipboard access.", ok ? "success" : "error");
  }

  const totalPending = useMemo(() => pending.reduce((s, p) => s + p.pending, 0), [pending]);
  const byCampaign = useMemo(() => {
    const m = new Map<string, { id: string | null; name: string; total: number; parts: string[] }>();
    for (const p of pending) {
      const key = p.campaign_id ?? "none";
      const e = m.get(key) ?? { id: p.campaign_id, name: p.campaign_name ?? "No campaign", total: 0, parts: [] };
      e.total += p.pending;
      e.parts.push(`${PLATFORM_LABELS[p.platform] ?? p.platform} ${p.pending}`);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) || b.total - a.total);
  }, [pending]);

  const TH = "px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-3 py-3 align-middle";
  const csvHref = `/api/submissions/export?${exportParams({ format: "csv" })}`;

  return (
    <div className="flex flex-col gap-4">
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {newCount > 0 && (
        <button
          onClick={refresh}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-brand-mint/10 border border-brand-mint/40 text-brand-mint hover:bg-brand-mint/20 transition-colors"
        >
          🔔 {newCount} new submission{newCount === 1 ? "" : "s"} arrived — click to refresh
        </button>
      )}

      {/* Pending-for-Whop counters, per campaign */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold text-[#7070a0] uppercase tracking-wide">
            Telegram links waiting for Whop: <span className="text-[#e8e8f0]">{totalPending.toLocaleString()}</span>
          </span>
          <button
            onClick={() => copyFromServer({ pending: "1", headers: groupHeaders ? "1" : "0" }, "pending links")}
            disabled={busy}
            className={`${BTN} bg-brand-blue text-white border-transparent hover:bg-[#6aadff]`}
            title="Copies every not-yet-submitted link matching the current filters (Telegram rows unless you picked a source)"
          >
            ⧉ Copy pending links
          </button>
          <a
            href={csvHref}
            download
            className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#e8e8f0] hover:border-brand-blue hover:text-brand-blue`}
            title={`Streams every row matching the current filters, ordered by campaign then platform (max ${EXPORT_MAX_ROWS.toLocaleString()})`}
          >
            ⬇ Export CSV{total > EXPORT_MAX_ROWS ? ` (first ${EXPORT_MAX_ROWS.toLocaleString()})` : ""}
          </a>
          <label className="flex items-center gap-1.5 text-[11px] text-[#7070a0] cursor-pointer">
            <input type="checkbox" checked={groupHeaders} onChange={(e) => setGroupHeaders(e.target.checked)} />
            “# Campaign – platform” lines when copying
          </label>
          <SoundToggle muted={muted} onToggle={() => toggleMuted(!muted)} />
        </div>
        {byCampaign.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {byCampaign.map((c) => (
              <button
                key={c.id ?? "none"}
                onClick={() => go({ ...filters, source: "telegram", whop: "pending", campaign: c.id ?? "none" }, 1, size)}
                title={`${c.parts.join(" · ")} — click to filter`}
                className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
                  c.id === null
                    ? "bg-brand-orange/10 border-brand-orange/30 text-brand-orange hover:bg-brand-orange/20"
                    : "bg-[#141428] border-[#1e1e38] text-[#e8e8f0] hover:border-brand-blue"}`}
              >
                {c.name} <span className="font-bold">{c.total.toLocaleString()}</span>
                <span className="text-[#7070a0]"> · {c.parts.join(" · ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <SubmissionsFilters
        filters={filters}
        campaigns={campaigns}
        size={size}
        busy={navPending}
        onApply={(f) => go(f, 1, size)}
        onSize={(s) => go(filters, 1, s)}
      />

      {/* Selection banner + bulk bar */}
      {(selectionCount > 0 || (allOnPageSelected && total > rows.length)) && (
        <div className="flex flex-col gap-2 px-4 py-3 bg-[#0f1a2a] border border-brand-blue/30 rounded-xl">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[#e8e8f0]">
            {allMatching ? (
              <>
                <span>All <b>{total.toLocaleString()}</b> matching rows are selected.</span>
                <button onClick={() => { setAllMatching(false); setSelected(new Set()); }} className="text-brand-blue hover:underline text-xs">Clear selection</button>
              </>
            ) : (
              <>
                <span><b>{selected.size}</b> selected on this page.</span>
                {allOnPageSelected && total > rows.length && (
                  <button onClick={() => setAllMatching(true)} className="text-brand-blue hover:underline text-xs font-semibold">
                    Select all {total.toLocaleString()} matching this filter
                  </button>
                )}
                {selected.size > 0 && (
                  <button onClick={() => setSelected(new Set())} className="text-[#7070a0] hover:text-white text-xs">Clear</button>
                )}
              </>
            )}
          </div>
          {selectionCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={bulkMark} disabled={busy} className={`${BTN} bg-brand-mint/10 border-brand-mint/40 text-brand-mint hover:bg-brand-mint/20`}>
                ✓ Mark submitted to Whop
              </button>
              <button onClick={bulkUnmark} disabled={busy} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-[#7070a0]`}>
                Unmark
              </button>
              <button onClick={copySelection} disabled={busy} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#e8e8f0] hover:border-brand-blue`}>
                ⧉ Copy links
              </button>
              <span className="mx-1 text-[#3a3a60]">|</span>
              <select
                value={assignTarget}
                onChange={(e) => setAssignTarget(e.target.value)}
                className="bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-2 py-1.5 text-xs text-[#e8e8f0] max-w-[200px] focus:outline-none focus:border-brand-blue"
              >
                <option value="">Assign campaign…</option>
                <option value="__none__">— clear campaign —</option>
                {campaigns.filter((c) => c.status !== "deleted").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={bulkAssign} disabled={busy || !assignTarget} className={`${BTN} bg-[#141428] border-[#1e1e38] text-brand-blue hover:border-brand-blue`}>
                Apply
              </button>
              {busy && <span className="text-xs text-[#7070a0]">working…</span>}
            </div>
          )}
        </div>
      )}

      <div className={`overflow-x-auto rounded-xl border border-[#1e1e38] ${navPending ? "opacity-60" : ""}`}>
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={`${TH} w-8`}>
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} aria-label="Select all rows on this page" />
              </th>
              <th className={TH}>User</th>
              <th className={TH}>Platform</th>
              <th className={TH}>Link</th>
              <th className={TH}>Campaign</th>
              <th className={TH}>Submitted</th>
              <th className={TH}>Status</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  {total > 0 && page > 1
                    ? <>This page is past the end. <button className="text-brand-blue hover:underline" onClick={() => go(filters, pageCount, size)}>Go to the last page</button></>
                    : "No submissions match these filters"}
                </td>
              </tr>
            )}
            {rows.map((s) => {
              const displayUser = s.user_email ?? `User #${s.hardware_id.slice(0, 6)}`;
              return (
                <tr key={s.id} className={`hover:bg-[#0f0f1c] transition-colors ${selected.has(s.id) || allMatching ? "bg-[#0f1a2a]/60" : ""}`}>
                  <td className={TD}>
                    <input type="checkbox" checked={selected.has(s.id) || allMatching} disabled={allMatching} onChange={() => toggleOne(s.id)} aria-label="Select row" />
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => go({ ...filters, user: s.user_id }, 1, size)}
                        title="Show only this user's links"
                        className="text-[#e8e8f0] text-xs text-left hover:text-brand-blue"
                      >
                        {displayUser}
                      </button>
                      {s.source === "telegram" && (
                        <span className="text-[10px] text-[#4a9eff]">
                          ✈ {s.telegram_username ? `@${s.telegram_username}` : `tg ${s.telegram_user_id}`}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">{PLATFORM_LABELS[s.platform] ?? s.platform}</span>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-1">
                      <LinkCell url={s.video_url} />
                      <FlagChips row={s} />
                    </div>
                  </td>
                  <td className={TD}>
                    <CampaignCell row={s} campaigns={campaigns} onPatch={(p) => patchRow(s.id, p)} onError={(m) => push(m, "error")} />
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[#7070a0] text-xs">{fmtDateTime(s.submitted_at)}</span>
                      <span className={`text-[10px] ${s.source === "telegram" ? "text-[#4a9eff]" : "text-[#3a3a60]"}`}>
                        {s.source === "telegram" ? "via Telegram" : "via desktop app"}
                      </span>
                    </div>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-1 items-start">
                      <StatusBadge status={s.status} />
                      {s.source === "telegram" && (
                        s.whop_submitted_at
                          ? <span className="text-[10px] text-brand-mint" title={fmtDateTime(s.whop_submitted_at)}>✓ submitted to Whop</span>
                          : <span className="text-[10px] text-brand-yellow">Whop: pending</span>
                      )}
                      {s.whop_confirmed && <span className="text-[10px] text-brand-mint">✓ Whop confirmed</span>}
                    </div>
                  </td>
                  <td className={TD}>
                    <RowActions row={s} onPatch={(p) => patchRow(s.id, p)} onError={(m) => push(m, "error")} onDone={refresh} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl text-sm">
        <span className="text-[#7070a0]">
          <span className="text-[#e8e8f0] font-semibold">{total.toLocaleString()}</span> submission{total === 1 ? "" : "s"}
          {total > 0 && <> · showing {((page - 1) * size + 1).toLocaleString()}–{Math.min(page * size, total).toLocaleString()}</>}
        </span>
        <div className="flex items-center gap-2 ml-auto">
          <button disabled={page <= 1 || navPending} onClick={() => go(filters, 1, size)} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-blue`}>«</button>
          <button disabled={page <= 1 || navPending} onClick={() => go(filters, page - 1, size)} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-blue`}>‹ Prev</button>
          <span className="text-xs text-[#7070a0]">Page <b className="text-[#e8e8f0]">{page}</b> of {pageCount.toLocaleString()}</span>
          <button disabled={page >= pageCount || navPending} onClick={() => go(filters, page + 1, size)} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-blue`}>Next ›</button>
          <button disabled={page >= pageCount || navPending} onClick={() => go(filters, pageCount, size)} className={`${BTN} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-blue`}>»</button>
        </div>
      </div>
    </div>
  );
}
