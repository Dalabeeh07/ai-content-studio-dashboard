"use client";

import { useMemo, useState } from "react";
import type { ClipRow } from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

const STATUS_COLORS: Record<string, string> = {
  done:       "text-brand-mint",
  processing: "text-brand-blue",
  pending:    "text-[#7070a0]",
  failed:     "text-brand-orange",
};

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({
  clips,
  user, setUser,
  dateFrom, setDateFrom,
  dateTo, setDateTo,
}: {
  clips: ClipRow[];
  user: string; setUser: (v: string) => void;
  dateFrom: string; setDateFrom: (v: string) => void;
  dateTo: string; setDateTo: (v: string) => void;
}) {
  const users = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of clips) {
      const hwid = c.hwid ?? "";
      if (hwid && !seen.has(hwid)) {
        seen.set(hwid, c.user_email ? c.user_email : `User #${hwid.slice(0, 6)}`);
      }
    }
    return Array.from(seen.entries());
  }, [clips]);

  const inputCls =
    "bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-1.5 text-sm text-[#e8e8f0]" +
    " focus:outline-none focus:border-[#4a9eff] placeholder-[#3a3a60] transition-colors";

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* User filter */}
      <select
        value={user}
        onChange={(e) => setUser(e.target.value)}
        className={inputCls}
      >
        <option value="">All users</option>
        {users.map(([hwid, label]) => (
          <option key={hwid} value={hwid}>{label}</option>
        ))}
      </select>

      {/* Date from */}
      <input
        type="date"
        value={dateFrom}
        onChange={(e) => setDateFrom(e.target.value)}
        className={inputCls}
      />
      <span className="text-[#3a3a60] text-sm">→</span>
      <input
        type="date"
        value={dateTo}
        onChange={(e) => setDateTo(e.target.value)}
        className={inputCls}
      />

      {/* Clear */}
      {(user || dateFrom || dateTo) && (
        <button
          onClick={() => { setUser(""); setDateFrom(""); setDateTo(""); }}
          className="text-xs text-[#7070a0] hover:text-brand-orange transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ClipsTable({ clips }: { clips: ClipRow[] }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo]     = useState("");
  const [user, setUser]         = useState("");

  const filtered = useMemo(() => {
    return clips.filter((c) => {
      if (user && c.hwid !== user) return false;
      if (dateFrom && c.created_at.slice(0, 10) < dateFrom) return false;
      if (dateTo   && c.created_at.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [clips, dateFrom, dateTo, user]);

  const totalEarnings = useMemo(
    () => filtered.reduce((s, c) => s + Number(c.earnings ?? 0), 0),
    [filtered]
  );

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        clips={clips}
        user={user} setUser={setUser}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo}
      />

      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={TH}>User</th>
              <th className={TH}>Clip ID</th>
              <th className={TH}>Created</th>
              <th className={TH}>Status</th>
              <th className={TH}>Earnings</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No clips match your filters
                </td>
              </tr>
            )}
            {filtered.map((c) => {
              const displayUser = c.user_email
                ? c.user_email
                : c.hwid
                  ? `User #${c.hwid.slice(0, 6)}`
                  : "Unknown";
              const earnings = c.earnings;

              return (
                <tr key={c.id} className="hover:bg-[#0f0f1c] transition-colors">
                  {/* User */}
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">{displayUser}</span>
                  </td>

                  {/* Clip ID */}
                  <td className={TD}>
                    <span className="font-mono text-xs text-[#7070a0]" title={c.id}>
                      {c.id.slice(0, 8)}…
                    </span>
                  </td>

                  {/* Created */}
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs">{fmtDate(c.created_at)}</span>
                  </td>

                  {/* Status */}
                  <td className={TD}>
                    <span className={`text-xs font-medium ${STATUS_COLORS[c.status ?? ""] ?? "text-[#7070a0]"}`}>
                      {c.status ?? "—"}
                    </span>
                  </td>

                  {/* Earnings */}
                  <td className={TD}>
                    {earnings != null && earnings > 0 ? (
                      <span className="text-brand-mint text-xs tabular-nums font-semibold">
                        ${earnings.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-[#3a3a60] text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Totals bar */}
      <div className="flex items-center gap-6 px-4 py-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl text-sm">
        <span className="text-[#7070a0]">
          <span className="text-[#e8e8f0] font-semibold">{filtered.length.toLocaleString()}</span> clips
        </span>
        <span className="text-[#3a3a60]">·</span>
        <span className="text-[#7070a0]">
          <span className="text-brand-mint font-semibold">${totalEarnings.toFixed(2)}</span> total earnings
        </span>
        {filtered.length !== clips.length && (
          <>
            <span className="text-[#3a3a60]">·</span>
            <span className="text-[#3a3a60] text-xs">{clips.length} total (filtered)</span>
          </>
        )}
      </div>
    </div>
  );
}
