"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { UserRow, LicenseStatus } from "@/lib/types";
import SendMessageModal from "./SendMessageModal";

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 2)  return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function isOnline(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 60 * 60 * 1000;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LicenseBadge({ status }: { status: LicenseStatus | null }) {
  const cfg: Record<string, string> = {
    active:  "bg-brand-mint/10 text-brand-mint border-brand-mint/30",
    expired: "bg-brand-orange/10 text-brand-orange border-brand-orange/30",
    revoked: "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",
  };
  const cls = cfg[status ?? ""] ?? "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
      {status ?? "None"}
    </span>
  );
}

function CopyCell({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      onClick={copy}
      title="Click to copy"
      className="font-mono text-xs text-[#7070a0] hover:text-brand-blue transition-colors"
    >
      {copied ? "✓ copied" : (display ?? value)}
    </button>
  );
}

// ── Revoke confirm dialog ─────────────────────────────────────────────────────

function RevokeDialog({
  user,
  onClose,
}: {
  user: UserRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleRevoke() {
    setError("");
    const res = await fetch("/api/users/revoke-license", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: user.license_key }),
    });
    if (res.ok) {
      setDone(true);
      setTimeout(() => {
        onClose();
        startTransition(() => router.refresh());
      }, 800);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Failed to revoke");
    }
  }

  const displayName = user.email
    ?? `User #${user.hwid.slice(0, 6)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-[#0f0f1c] border border-[#1e1e38] rounded-2xl p-6 shadow-2xl">
        {done ? (
          <p className="text-brand-mint text-center py-4 font-semibold">✓ License revoked</p>
        ) : (
          <>
            <h2 className="text-white font-bold text-lg mb-2">Revoke License?</h2>
            <p className="text-[#7070a0] text-sm mb-5">
              This will revoke the license for <strong className="text-white">{displayName}</strong>.
              The user will lose access immediately.
            </p>
            {error && <p className="text-brand-orange text-sm mb-3">{error}</p>}
            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-[#7070a0]
                           border border-[#1e1e38] hover:border-[#3a3a60] hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={pending}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white
                           bg-brand-orange hover:bg-[#ff8860] disabled:bg-[#3a3a60] transition-colors"
              >
                Revoke
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main table ────────────────────────────────────────────────────────────────

export default function UsersTable({ users }: { users: UserRow[] }) {
  const [msgTarget, setMsgTarget]     = useState<UserRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserRow | null>(null);

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={TH}>User</th>
              <th className={TH}>Device ID</th>
              <th className={TH}>License</th>
              <th className={TH}>Clips (30d)</th>
              <th className={TH}>Last Active</th>
              <th className={TH}>Whop Earnings</th>
              <th className={TH}>Status</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {users.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No users yet
                </td>
              </tr>
            )}
            {users.map((u) => {
              const displayName = u.email ?? `User #${u.hwid.slice(0, 6)}`;
              const online = isOnline(u.last_active_at);

              return (
                <tr
                  key={u.id}
                  className="hover:bg-[#0f0f1c] transition-colors"
                >
                  {/* User */}
                  <td className={TD}>
                    <span className="text-[#e8e8f0] font-medium">{displayName}</span>
                  </td>

                  {/* Device ID */}
                  <td className={TD}>
                    <CopyCell
                      value={u.hwid}
                      display={u.hwid.slice(0, 12) + "…"}
                    />
                  </td>

                  {/* License */}
                  <td className={TD}>
                    <div className="flex flex-col gap-1">
                      {u.license_key && (
                        <CopyCell
                          value={u.license_key}
                          display={u.license_key.slice(0, 4) + "-****"}
                        />
                      )}
                      <LicenseBadge status={u.license_status} />
                    </div>
                  </td>

                  {/* Clips 30d */}
                  <td className={TD}>
                    <span className={u.clip_count_30d > 0 ? "text-[#e8e8f0]" : "text-[#3a3a60]"}>
                      {u.clip_count_30d}
                    </span>
                  </td>

                  {/* Last Active */}
                  <td className={TD}>
                    <span className="text-[#7070a0]">
                      {relativeTime(u.last_active_at)}
                    </span>
                  </td>

                  {/* Earnings */}
                  <td className={TD}>
                    {u.total_earnings > 0 ? (
                      <span className="text-brand-mint font-semibold tabular-nums">
                        ${u.total_earnings.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-[#3a3a60]">—</span>
                    )}
                  </td>

                  {/* Status */}
                  <td className={TD}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${online ? "bg-brand-mint" : "bg-[#3a3a60]"}`}
                      />
                      <span className={`text-xs ${online ? "text-brand-mint" : "text-[#7070a0]"}`}>
                        {online ? "Online" : "Inactive"}
                      </span>
                    </span>
                  </td>

                  {/* Actions */}
                  <td className={TD}>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setMsgTarget(u)}
                        className="px-3 py-1 rounded-md text-xs font-medium
                                   bg-[#141428] border border-[#1e1e38]
                                   text-[#4a9eff] hover:border-[#4a9eff] hover:bg-[#0e1e38]
                                   transition-colors"
                      >
                        Message
                      </button>
                      <button
                        onClick={() => setRevokeTarget(u)}
                        disabled={u.license_status === "revoked" || !u.license_key}
                        className="px-3 py-1 rounded-md text-xs font-medium
                                   bg-[#141428] border border-[#1e1e38]
                                   text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]
                                   disabled:text-[#3a3a60] disabled:border-[#1e1e38] disabled:cursor-not-allowed
                                   transition-colors"
                      >
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {msgTarget && (
        <SendMessageModal
          user={msgTarget}
          onClose={() => setMsgTarget(null)}
        />
      )}

      {revokeTarget && (
        <RevokeDialog
          user={revokeTarget}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}
