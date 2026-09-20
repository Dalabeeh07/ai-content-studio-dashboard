"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { updateSubmissionStatus, setWhopConfirmed } from "@/app/submissions/actions";
import { browserClient } from "@/lib/supabase";
import { useCopyToClipboard } from "@/components/CopyCell";
import { ToastStack, useToasts } from "@/components/Toast";
import { playNotificationChime, unlockAudioOnNextInteraction, useSoundMuted } from "@/lib/sound";
import type { SubmissionRow, SubmissionStatus } from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
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

// ── Link cell: openable link + a dedicated copy button ──────────────────────

function LinkCell({ url }: { url: string }) {
  const [state, copy] = useCopyToClipboard();
  const truncated = url.length > 40 ? `${url.slice(0, 40)}…` : url;
  return (
    <div className="flex items-center gap-1.5">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-blue hover:underline text-xs break-all"
        title={url}
      >
        {truncated}
      </a>
      <button
        onClick={() => copy(url)}
        title="Copy link"
        className={`shrink-0 text-[10px] leading-none px-1.5 py-1 rounded border transition-colors
          ${state === "copied"
            ? "border-brand-mint/40 text-brand-mint"
            : state === "failed"
            ? "border-brand-orange/40 text-brand-orange"
            : "border-[#1e1e38] text-[#7070a0] hover:border-brand-blue hover:text-brand-blue"
          }`}
      >
        {state === "copied" ? "✓" : state === "failed" ? "✗" : "⧉"}
      </button>
    </div>
  );
}

// ── Row actions ────────────────────────────────────────────────────────────────

function RowActions({ row }: { row: SubmissionRow }) {
  const [pending, startTransition] = useTransition();

  function setStatus(status: SubmissionStatus) {
    startTransition(async () => {
      await updateSubmissionStatus(row.id, status);
    });
  }

  function toggleWhop() {
    startTransition(async () => {
      await setWhopConfirmed(row.id, !row.whop_confirmed);
    });
  }

  const btnBase =
    "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex gap-1.5 flex-wrap">
      <button
        onClick={toggleWhop}
        disabled={pending}
        title="Toggle after you've manually checked the matching Whop submission exists"
        className={`${btnBase} ${
          row.whop_confirmed
            ? "bg-[#0f2a1a] border-brand-mint/40 text-brand-mint"
            : "bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-brand-mint hover:text-brand-mint"
        }`}
      >
        {row.whop_confirmed ? "✓ Whop confirmed" : "Confirm on Whop"}
      </button>
      {row.status !== "verified" && (
        <button
          onClick={() => setStatus("verified")}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-blue hover:border-brand-blue hover:bg-[#0f1a2a]`}
        >
          Mark Verified
        </button>
      )}
      {row.status !== "disputed" && (
        <button
          onClick={() => setStatus("disputed")}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]`}
        >
          Mark Disputed
        </button>
      )}
      {row.status !== "pending_review" && (
        <button
          onClick={() => setStatus("pending_review")}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-[#7070a0] hover:bg-[#1a1a2e]`}
        >
          Reset to Pending
        </button>
      )}
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({
  filter, setFilter, counts,
}: {
  filter: string;
  setFilter: (v: string) => void;
  counts: Record<string, number>;
}) {
  const options: { value: string; label: string }[] = [
    { value: "all", label: `All (${counts.all})` },
    { value: "pending_review", label: `Pending Review (${counts.pending_review})` },
    { value: "verified", label: `Verified (${counts.verified})` },
    { value: "disputed", label: `Disputed (${counts.disputed})` },
  ];
  return (
    <select
      value={filter}
      onChange={(e) => setFilter(e.target.value)}
      className="bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-1.5 text-sm
                 text-[#e8e8f0] focus:outline-none focus:border-[#4a9eff] transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Sound mute toggle ────────────────────────────────────────────────────────

function SoundToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={muted ? "Unmute new-submission sound" : "Mute new-submission sound"}
      className="px-2.5 py-1.5 rounded-lg text-sm border border-[#1e1e38] text-[#7070a0]
                 hover:border-brand-blue hover:text-brand-blue transition-colors"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

// ── Realtime payload -> SubmissionRow ────────────────────────────────────────

// Only the columns migration 024 grants anon SELECT on (and that the
// client's `select` filter below explicitly asks for) ever arrive here -
// user_id and updated_at are deliberately never requested (see that
// migration's header), so they're filled with inert placeholders rather
// than left undefined. Neither is read anywhere in this file's rendering
// - user_email (which WOULD come from user_id via a join) already has its
// own "User #<hwid prefix>" fallback below for exactly this case.
interface RealtimeSubmissionInsert {
  id: string;
  hardware_id: string;
  platform: SubmissionRow["platform"];
  video_url: string;
  username: string;
  status: SubmissionStatus;
  whop_confirmed: boolean;
  submitted_at: string;
}

function fromRealtimeInsert(row: RealtimeSubmissionInsert): SubmissionRow {
  return {
    id: row.id,
    user_id: "",
    hardware_id: row.hardware_id,
    user_email: null,
    platform: row.platform,
    video_url: row.video_url,
    username: row.username,
    status: row.status,
    whop_confirmed: Boolean(row.whop_confirmed),
    submitted_at: row.submitted_at,
    updated_at: row.submitted_at,
  };
}

// ── Main table ────────────────────────────────────────────────────────────────

export default function SubmissionsTable({ submissions: initialSubmissions }: { submissions: SubmissionRow[] }) {
  const [filter, setFilter] = useState("all");
  const [submissions, setSubmissions] = useState<SubmissionRow[]>(initialSubmissions);
  const [newRowIds, setNewRowIds] = useState<Set<string>>(new Set());
  const [muted, toggleMuted] = useSoundMuted();
  // Realtime's subscription effect below runs once (empty deps) and its
  // callback closure would otherwise capture whatever `muted` was at
  // that moment forever - this ref is kept current via its own effect
  // (never written during render) so the callback always sees the latest
  // value without needing to resubscribe the channel on every toggle.
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const { toasts, push, dismiss } = useToasts();

  // New data from the server (RefreshButton's router.refresh()) should
  // replace local state outright, not be shadowed by whatever Realtime
  // has accumulated since - same "adjust state during render" pattern as
  // UsersTable.tsx, for the same reason (avoids an extra render vs. doing
  // this in a useEffect).
  const [lastSeenInitial, setLastSeenInitial] = useState(initialSubmissions);
  if (initialSubmissions !== lastSeenInitial) {
    setLastSeenInitial(initialSubmissions);
    setSubmissions(initialSubmissions);
  }

  useEffect(() => {
    unlockAudioOnNextInteraction();
  }, []);

  // Browser notification permission: ask once, on load, only while the
  // browser hasn't been asked before ("default"). Once answered, the
  // permission is no longer "default" on future visits, so this can run
  // unconditionally on every mount without ever re-prompting - the
  // browser itself is what makes this non-intrusive, not extra state here.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Live INSERTs (migration 024): `select` restricts the payload to
  // exactly the columns anon has been granted - without it, Realtime
  // would send the row's full column set by default regardless of the
  // DB-side GRANT (verified directly against @supabase/realtime-js's own
  // types and a real live test - see migration 024's header for details).
  useEffect(() => {
    const channel = browserClient
      .channel("submissions-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "video_submissions",
          select: [
            "id", "hardware_id", "platform", "video_url",
            "username", "status", "submitted_at", "whop_confirmed",
          ],
        },
        (payload) => {
          const inserted = fromRealtimeInsert(payload.new as RealtimeSubmissionInsert);

          setSubmissions((prev) =>
            prev.some((s) => s.id === inserted.id) ? prev : [inserted, ...prev]
          );

          setNewRowIds((prev) => new Set(prev).add(inserted.id));
          setTimeout(() => {
            setNewRowIds((prev) => {
              const next = new Set(prev);
              next.delete(inserted.id);
              return next;
            });
          }, 2500);

          const platformLabel = PLATFORM_LABELS[inserted.platform] ?? inserted.platform;
          push(`New submission: @${inserted.username} (${platformLabel})`, "success");

          if (!mutedRef.current) playNotificationChime();

          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            try {
              const n = new Notification("New video submission", {
                body: `@${inserted.username} submitted a ${platformLabel} link`,
                tag: `submission-${inserted.id}`,
              });
              n.onclick = () => {
                window.focus();
                n.close();
              };
            } catch {
              // Notification constructor can throw in some environments -
              // the in-page toast above already covers this either way.
            }
          }
        }
      )
      .subscribe();

    return () => {
      browserClient.removeChannel(channel);
    };
  }, [push]);

  const counts = useMemo(() => ({
    all: submissions.length,
    pending_review: submissions.filter((s) => s.status === "pending_review").length,
    verified: submissions.filter((s) => s.status === "verified").length,
    disputed: submissions.filter((s) => s.status === "disputed").length,
  }), [submissions]);

  const filtered = useMemo(() => {
    if (filter === "all") return submissions;
    return submissions.filter((s) => s.status === filter);
  }, [submissions, filter]);

  const TH = "px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-3 py-3 align-middle";

  return (
    <div className="flex flex-col gap-4">
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      <div className="flex items-center gap-3">
        <FilterBar filter={filter} setFilter={setFilter} counts={counts} />
        <SoundToggle muted={muted} onToggle={() => toggleMuted(!muted)} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={TH}>User</th>
              <th className={TH}>Platform</th>
              <th className={TH}>Link</th>
              <th className={TH}>Username</th>
              <th className={TH}>Submitted</th>
              <th className={TH}>Status</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No submissions match this filter
                </td>
              </tr>
            )}
            {filtered.map((s) => {
              const displayUser = s.user_email ?? `User #${s.hardware_id.slice(0, 6)}`;
              return (
                <tr
                  key={s.id}
                  className={`hover:bg-[#0f0f1c] transition-colors ${newRowIds.has(s.id) ? "animate-row-flash" : ""}`}
                >
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">{displayUser}</span>
                  </td>
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">
                      {PLATFORM_LABELS[s.platform] ?? s.platform}
                    </span>
                  </td>
                  <td className={TD}>
                    <LinkCell url={s.video_url} />
                  </td>
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">@{s.username}</span>
                  </td>
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs">{fmtDateTime(s.submitted_at)}</span>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-1 items-start">
                      <StatusBadge status={s.status} />
                      {s.whop_confirmed && (
                        <span className="text-[10px] text-brand-mint">✓ Whop confirmed</span>
                      )}
                    </div>
                  </td>
                  <td className={TD}>
                    <RowActions row={s} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-6 px-4 py-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl text-sm">
        <span className="text-[#7070a0]">
          <span className="text-[#e8e8f0] font-semibold">{filtered.length.toLocaleString()}</span> submissions
        </span>
      </div>
    </div>
  );
}
