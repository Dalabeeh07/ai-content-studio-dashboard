"use client";

import { useMemo, useState, useTransition } from "react";
import { updateSubmissionStatus, setWhopConfirmed } from "@/app/submissions/actions";
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
  paid:           { cls: "bg-brand-mint/10 text-brand-mint border-brand-mint/30", label: "Paid" },
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
      {row.status !== "paid" && (
        <button
          onClick={() => setStatus("paid")}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-mint hover:border-brand-mint hover:bg-[#0f2a1a]`}
        >
          Mark Paid
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
    { value: "paid", label: `Paid (${counts.paid})` },
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

// ── Main table ────────────────────────────────────────────────────────────────

export default function SubmissionsTable({ submissions }: { submissions: SubmissionRow[] }) {
  const [filter, setFilter] = useState("all");

  const counts = useMemo(() => ({
    all: submissions.length,
    pending_review: submissions.filter((s) => s.status === "pending_review").length,
    verified: submissions.filter((s) => s.status === "verified").length,
    paid: submissions.filter((s) => s.status === "paid").length,
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
      <div className="flex items-center gap-3">
        <FilterBar filter={filter} setFilter={setFilter} counts={counts} />
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
                <tr key={s.id} className="hover:bg-[#0f0f1c] transition-colors">
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">{displayUser}</span>
                  </td>
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">
                      {PLATFORM_LABELS[s.platform] ?? s.platform}
                    </span>
                  </td>
                  <td className={TD}>
                    <a
                      href={s.video_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-blue hover:underline text-xs break-all"
                      title={s.video_url}
                    >
                      {s.video_url.length > 40 ? `${s.video_url.slice(0, 40)}…` : s.video_url}
                    </a>
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
