"use client";

import { useCallback, useEffect, useState } from "react";

type PendingUser = {
  id: string;
  email: string;
  hwid: string;
  status: "pending" | "approved" | "rejected";
  registered_at: string;
  reject_reason: string | null;
};

export default function PendingPage() {
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectInput, setRejectInput] = useState<Record<string, string>>({});
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
        body: JSON.stringify({ action, reject_reason: rejectInput[id] ?? "" }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pending = users.filter((u) => u.status === "pending");
  const reviewed = users.filter((u) => u.status !== "pending");

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Pending Approvals</h1>
          <p className="text-muted text-sm mt-1">
            Users waiting for Gmail verification review
          </p>
        </div>
        <span className="bg-brand-blue/10 text-brand-blue text-sm font-semibold px-3 py-1 rounded-full">
          {pending.length} pending
        </span>
      </div>

      {loading && (
        <p className="text-muted text-sm">Loading…</p>
      )}

      {!loading && pending.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-card px-6 py-10 text-center text-muted text-sm">
          No pending registrations.
        </div>
      )}

      {pending.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-card text-muted text-left text-xs uppercase tracking-wide">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">HWID</th>
                <th className="px-4 py-3">Registered</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pending.map((u) => (
                <tr key={u.id} className="bg-bg-surface hover:bg-bg-card transition-colors">
                  <td className="px-4 py-3 text-text font-medium">{u.email}</td>
                  <td className="px-4 py-3 text-muted font-mono text-xs">
                    {u.hwid.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {new Date(u.registered_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        disabled={busy === u.id}
                        onClick={() => act(u.id, "approve")}
                        className="px-3 py-1.5 rounded-lg bg-brand-blue/10 text-brand-blue
                                   text-xs font-semibold hover:bg-brand-blue/20
                                   disabled:opacity-50 transition-colors"
                      >
                        ✓ Approve
                      </button>
                      <input
                        type="text"
                        placeholder="Rejection reason…"
                        value={rejectInput[u.id] ?? ""}
                        onChange={(e) =>
                          setRejectInput((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        className="text-xs px-2 py-1.5 rounded-lg border border-border
                                   bg-bg-card text-text placeholder-muted w-40
                                   focus:outline-none focus:border-brand-blue"
                      />
                      <button
                        disabled={busy === u.id}
                        onClick={() => act(u.id, "reject")}
                        className="px-3 py-1.5 rounded-lg bg-brand-orange/10 text-brand-orange
                                   text-xs font-semibold hover:bg-brand-orange/20
                                   disabled:opacity-50 transition-colors"
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewed.length > 0 && (
        <div className="mt-10">
          <h2 className="text-base font-semibold text-text mb-3">Recent Reviews</h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-card text-muted text-left text-xs uppercase tracking-wide">
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Reviewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reviewed.slice(0, 20).map((u) => (
                  <tr key={u.id} className="bg-bg-surface">
                    <td className="px-4 py-3 text-text">{u.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          u.status === "approved"
                            ? "bg-brand-blue/10 text-brand-blue"
                            : "bg-brand-orange/10 text-brand-orange"
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs">{u.reject_reason || "—"}</td>
                    <td className="px-4 py-3 text-muted text-xs">
                      {u.reviewed_at ? new Date(u.reviewed_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
