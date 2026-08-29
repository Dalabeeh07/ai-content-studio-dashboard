"use client";

import { useMemo, useState } from "react";
import type { ClipRow } from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function truncUrl(url: string, max = 32): string {
  try {
    const u = new URL(url);
    const path = u.hostname + u.pathname;
    return path.length > max ? path.slice(0, max) + "…" : path;
  } catch {
    return url.length > max ? url.slice(0, max) + "…" : url;
  }
}

const CONTENT_TYPE_LABELS: Record<string, string> = {
  gaming:  "🎮 Gaming",
  podcast: "🎙 Podcast",
  vlog:    "📹 Vlog",
  casino:  "🎰 Casino",
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok:    "TikTok",
  youtube:   "YouTube",
};

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({
  clips,
  contentType, setContentType,
  dateFrom, setDateFrom,
  dateTo, setDateTo,
  user, setUser,
}: {
  clips: ClipRow[];
  contentType: string; setContentType: (v: string) => void;
  dateFrom: string; setDateFrom: (v: string) => void;
  dateTo: string; setDateTo: (v: string) => void;
  user: string; setUser: (v: string) => void;
}) {
  const contentTypes = useMemo(() => {
    const s = new Set(clips.map((c) => c.content_type).filter(Boolean));
    return Array.from(s).sort();
  }, [clips]);

  const users = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of clips) {
      const hwid = c.user_hardware_id ?? "";
      if (hwid && !seen.has(hwid)) {
        seen.set(hwid, c.whop_username ? `@${c.whop_username}` : `User #${hwid.slice(0, 6)}`);
      }
    }
    return Array.from(seen.entries());
  }, [clips]);

  const inputCls =
    "bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-1.5 text-sm text-[#e8e8f0]" +
    " focus:outline-none focus:border-[#4a9eff] placeholder-[#3a3a60] transition-colors";

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* Content type */}
      <select
        value={contentType}
        onChange={(e) => setContentType(e.target.value)}
        className={inputCls}
      >
        <option value="">All types</option>
        {contentTypes.map((ct) => (
          <option key={ct} value={ct}>
            {CONTENT_TYPE_LABELS[ct] ?? ct}
          </option>
        ))}
      </select>

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
      {(contentType || user || dateFrom || dateTo) && (
        <button
          onClick={() => {
            setContentType(""); setUser("");
            setDateFrom(""); setDateTo("");
          }}
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
  const [contentType, setContentType] = useState("");
  const [dateFrom, setDateFrom]       = useState("");
  const [dateTo, setDateTo]           = useState("");
  const [user, setUser]               = useState("");

  const filtered = useMemo(() => {
    return clips.filter((c) => {
      if (contentType && c.content_type !== contentType) return false;
      if (user && c.user_hardware_id !== user) return false;
      if (dateFrom && c.exported_at < dateFrom) return false;
      if (dateTo   && c.exported_at.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [clips, contentType, dateFrom, dateTo, user]);

  const totalEarnings = useMemo(
    () => filtered.reduce((s, c) => s + Number(c.estimated_earnings_usd ?? 0), 0),
    [filtered]
  );

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        clips={clips}
        contentType={contentType} setContentType={setContentType}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo}
        user={user} setUser={setUser}
      />

      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={TH}>User</th>
              <th className={TH}>Filename</th>
              <th className={TH}>Type</th>
              <th className={TH}>Duration</th>
              <th className={TH}>Score</th>
              <th className={TH}>Exported</th>
              <th className={TH}>Published</th>
              <th className={TH}>Platform</th>
              <th className={TH}>Views</th>
              <th className={TH}>Est. Earnings</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No clips match your filters
                </td>
              </tr>
            )}
            {filtered.map((c) => {
              const displayUser = c.whop_username
                ? `@${c.whop_username}`
                : c.user_hardware_id
                  ? `User #${c.user_hardware_id.slice(0, 6)}`
                  : "Unknown";
              const views = c.views;
              const earnings = c.estimated_earnings_usd;

              return (
                <tr key={c.id} className="hover:bg-[#0f0f1c] transition-colors">
                  {/* User */}
                  <td className={TD}>
                    <span className="text-[#e8e8f0] text-xs">{displayUser}</span>
                  </td>

                  {/* Filename */}
                  <td className={TD}>
                    <span className="font-mono text-xs text-[#7070a0] max-w-[160px] block truncate" title={c.filename}>
                      {c.filename}
                    </span>
                  </td>

                  {/* Content type */}
                  <td className={TD}>
                    <span className="text-xs text-[#e8e8f0]">
                      {CONTENT_TYPE_LABELS[c.content_type] ?? c.content_type}
                    </span>
                  </td>

                  {/* Duration */}
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs tabular-nums">
                      {fmtDuration(c.duration_sec)}
                    </span>
                  </td>

                  {/* Score */}
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs tabular-nums">
                      {c.score != null ? c.score.toFixed(2) : "—"}
                    </span>
                  </td>

                  {/* Exported */}
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs">{fmtDate(c.exported_at)}</span>
                  </td>

                  {/* Published URL */}
                  <td className={TD}>
                    {c.published_url ? (
                      <a
                        href={c.published_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={c.published_url}
                        className="text-brand-blue hover:underline text-xs"
                      >
                        {truncUrl(c.published_url)}
                      </a>
                    ) : (
                      <span className="text-[#3a3a60] text-xs">Not published</span>
                    )}
                  </td>

                  {/* Platform */}
                  <td className={TD}>
                    <span className="text-[#7070a0] text-xs">
                      {PLATFORM_LABELS[c.platform ?? ""] ?? c.platform ?? "—"}
                    </span>
                  </td>

                  {/* Views */}
                  <td className={TD}>
                    {views != null ? (
                      <span className={`text-xs tabular-nums font-medium ${views >= 1000 ? "text-brand-mint" : "text-[#e8e8f0]"}`}>
                        {views.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-[#3a3a60] text-xs">—</span>
                    )}
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
          <span className="text-brand-mint font-semibold">${totalEarnings.toFixed(2)}</span> total estimated earnings
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
