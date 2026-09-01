"use client";

import { useCallback, useEffect, useState } from "react";
import type { PendingUser } from "@/lib/types";

// ── Social badges ─────────────────────────────────────────────────────────────
// UsersTable.tsx has an equivalent SocialBadges, but it isn't exported from
// that file, so per the "otherwise create a simple inline component"
// fallback, this is a small local version with the same visual style.

const PLATFORM_META: Record<string, { label: string; color: string }> = {
  instagram: { label: "IG", color: "bg-[#e1306c]/20 text-[#e1306c] border-[#e1306c]/30" },
  tiktok:    { label: "TT", color: "bg-[#69c9d0]/20 text-[#69c9d0] border-[#69c9d0]/30" },
  youtube:   { label: "YT", color: "bg-[#ff0000]/20 text-[#ff0000] border-[#ff0000]/30" },
  x:         { label: "X",  color: "bg-[#e8e8f0]/10 text-[#e8e8f0] border-[#e8e8f0]/20" },
  snapchat:  { label: "SC", color: "bg-[#fffc00]/10 text-[#e8e000] border-[#fffc00]/20" },
};

function SocialBadges({ accounts }: { accounts: PendingUser["social_accounts"] }) {
  if (!accounts || accounts.length === 0) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {accounts.map((a, i) => {
        const meta = PLATFORM_META[a.platform] ?? {
          label: a.platform.toUpperCase().slice(0, 2),
          color: "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",
        };
        return (
          <span
            key={i}
            title={`${a.platform}: ${a.username}`}
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${meta.color}`}
          >
            {meta.label} {a.username}
          </span>
        );
      })}
    </div>
  );
}

// ── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: PendingUser["status"] }) {
  const cfg = {
    pending:  { bg: "#ffc44422", color: "#ffc444", label: "قيد المراجعة" },
    approved: { bg: "#3dffa022", color: "#3dffa0", label: "موافق" },
    rejected: { bg: "#ff615122", color: "#ff6151", label: "مرفوض" },
  }[status];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ backgroundColor: cfg.bg, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PendingPage() {
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pending/list");
      if (res.ok) setUsers(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id: string, action: "approve" | "reject") => {
    setBusy(id);
    try {
      await fetch(`/api/pending/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pendingCount = users.filter((u) => u.status === "pending").length;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Pending Approvals</h1>
          <p className="text-muted text-sm mt-1">
            Users waiting for admin review
          </p>
        </div>
        <span className="bg-brand-blue/10 text-brand-blue text-sm font-semibold px-3 py-1 rounded-full">
          {pendingCount} pending
        </span>
      </div>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {!loading && users.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-card px-6 py-10 text-center text-muted text-sm">
          No requests yet.
        </div>
      )}

      {users.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-card text-muted text-left text-xs uppercase tracking-wide">
                <th className="px-4 py-3">الاسم الكامل</th>
                <th className="px-4 py-3">يوزر Whop</th>
                <th className="px-4 py-3">مفتاح الرخصة</th>
                <th className="px-4 py-3">الحسابات الاجتماعية</th>
                <th className="px-4 py-3">Gemini Key</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3">تاريخ التقديم</th>
                <th className="px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => {
                const decided = u.status !== "pending";
                const isBusy = busy === u.id;
                return (
                  <tr key={u.id} className="bg-bg-surface hover:bg-bg-card transition-colors">
                    <td className="px-4 py-3 text-text font-medium">
                      {u.full_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {u.whop_username ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted font-mono text-xs">
                      {u.license_key ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <SocialBadges accounts={u.social_accounts} />
                    </td>
                    <td className="px-4 py-3 text-muted font-mono text-xs">
                      {u.gemini_key_hint ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={u.status} />
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {new Date(u.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          disabled={decided || isBusy}
                          onClick={() => act(u.id, "approve")}
                          className="px-3 py-1.5 rounded-lg bg-[#3dffa0]/10 text-[#3dffa0]
                                     text-xs font-semibold hover:bg-[#3dffa0]/20
                                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {isBusy ? "…" : "موافقة"}
                        </button>
                        <button
                          disabled={decided || isBusy}
                          onClick={() => act(u.id, "reject")}
                          className="px-3 py-1.5 rounded-lg bg-[#ff6151]/10 text-[#ff6151]
                                     text-xs font-semibold hover:bg-[#ff6151]/20
                                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {isBusy ? "…" : "رفض"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
