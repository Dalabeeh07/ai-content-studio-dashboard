"use client";

import { useState, useTransition, useMemo } from "react";
import { revokeLicense, bulkRevoke, unbindDevice, updateCredits } from "@/app/licenses/actions";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LicenseRow {
  id: string;
  key: string;
  label: string | null;
  credits_limit: number;
  hardware_id: string | null;
  status: "active" | "expired" | "revoked";
  activated_at: string | null;
  created_at: string;
  expires_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function effectiveStatus(row: LicenseRow): "active" | "expired" | "revoked" | "pending" {
  if (row.status === "revoked") return "revoked";
  if (row.expires_at && new Date(row.expires_at) < new Date()) return "expired";
  if (!row.hardware_id) return "pending";
  return "active";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "2-digit",
  });
}

function maskKey(k: string): string {
  const parts = k.split("-");
  if (parts.length !== 4) return k;
  return `${parts[0]}-****-****-${parts[3]}`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "active" | "expired" | "revoked" | "pending" }) {
  const cfg = {
    active:  { cls: "bg-brand-mint/10 text-brand-mint border-brand-mint/30",   label: "Active" },
    expired: { cls: "bg-brand-orange/10 text-brand-orange border-brand-orange/30", label: "Expired" },
    revoked: { cls: "bg-red-900/20 text-red-400 border-red-800/40",             label: "Revoked" },
    pending: { cls: "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",         label: "Pending" },
  };
  const { cls, label } = cfg[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
      {label}
    </span>
  );
}

// ── Key cell (reveal toggle) ──────────────────────────────────────────────────

function KeyCell({ licenseKey }: { licenseKey: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied]     = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(licenseKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setRevealed((r) => !r)}
        title={revealed ? "Click to hide" : "Click to reveal"}
        className="font-mono text-xs text-[#e8e8f0] hover:text-brand-blue transition-colors"
      >
        {revealed ? licenseKey : maskKey(licenseKey)}
      </button>
      <button
        onClick={copy}
        className="text-[10px] text-[#3a3a60] hover:text-brand-blue transition-colors"
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

// ── Edit credits inline ───────────────────────────────────────────────────────

function EditCreditsCell({ licenseKey, current }: { licenseKey: string; current: number }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue]     = useState(current);
  const [pending, startTransition] = useTransition();
  const [err, setErr]         = useState("");

  function save() {
    setErr("");
    startTransition(async () => {
      const r = await updateCredits(licenseKey, value);
      if (r.ok) {
        setEditing(false);
      } else {
        setErr(r.error ?? "Failed");
      }
    });
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-xs text-[#e8e8f0] hover:text-brand-blue transition-colors group"
      >
        {current}
        <span className="ml-1 text-[#3a3a60] group-hover:text-brand-blue">✎</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        min={1}
        max={10000}
        autoFocus
        className="w-16 bg-[#0f0f1c] border border-brand-blue rounded px-2 py-0.5 text-xs
                   text-[#e8e8f0] focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button
        onClick={save}
        disabled={pending}
        className="text-xs text-brand-mint hover:opacity-80 disabled:opacity-40"
      >
        ✓
      </button>
      <button
        onClick={() => { setEditing(false); setValue(current); }}
        className="text-xs text-[#7070a0] hover:text-brand-orange"
      >
        ✕
      </button>
      {err && <span className="text-brand-orange text-[10px]">{err}</span>}
    </div>
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────

function ActionCell({ row }: { row: LicenseRow }) {
  const [pending, startTransition] = useTransition();
  const status = effectiveStatus(row);

  function handleRevoke() {
    if (!confirm(`Revoke license ${maskKey(row.key)}? This will cut off the user immediately.`)) return;
    startTransition(async () => { await revokeLicense(row.key); });
  }

  function handleUnbind() {
    if (!confirm(`Unbind device from ${maskKey(row.key)}? The key can be re-activated on a new device.`)) return;
    startTransition(async () => { await unbindDevice(row.key); });
  }

  const btnBase =
    "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex gap-1.5 flex-wrap">
      {status !== "revoked" && (
        <button
          onClick={handleRevoke}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]`}
        >
          Revoke
        </button>
      )}
      {row.hardware_id && status !== "revoked" && (
        <button
          onClick={handleUnbind}
          disabled={pending}
          className={`${btnBase} bg-[#141428] border-[#1e1e38] text-brand-yellow hover:border-brand-yellow hover:bg-[#1a1400]`}
        >
          Unbind
        </button>
      )}
    </div>
  );
}

// ── Main table ────────────────────────────────────────────────────────────────

export default function LicensesTable({ licenses }: { licenses: LicenseRow[] }) {
  const [filter, setFilter]       = useState("all");
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [bulkPending, startBulk]  = useTransition();
  const [bulkError, setBulkError] = useState("");

  const filtered = useMemo(() => {
    if (filter === "all") return licenses;
    return licenses.filter((l) => effectiveStatus(l) === filter);
  }, [licenses, filter]);

  // Stats
  const stats = useMemo(() => ({
    total:   licenses.length,
    active:  licenses.filter((l) => effectiveStatus(l) === "active").length,
    pending: licenses.filter((l) => effectiveStatus(l) === "pending").length,
    revoked: licenses.filter((l) => effectiveStatus(l) === "revoked").length,
  }), [licenses]);

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((l) => l.key)));
    }
  }

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function handleBulkRevoke() {
    const keys = Array.from(selected);
    if (keys.length === 0) return;
    if (!confirm(`Revoke ${keys.length} selected license${keys.length > 1 ? "s" : ""}?`)) return;
    setBulkError("");
    startBulk(async () => {
      const r = await bulkRevoke(keys);
      if (r.ok) {
        setSelected(new Set());
      } else {
        setBulkError(r.error ?? "Bulk revoke failed.");
      }
    });
  }

  const TH = "px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-3 py-3 align-middle";

  const filterOptions = [
    { value: "all",     label: "All" },
    { value: "active",  label: "Active" },
    { value: "pending", label: "Pending" },
    { value: "expired", label: "Expired" },
    { value: "revoked", label: "Revoked" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Stats bar */}
      <div className="flex gap-5 px-5 py-3 bg-[#141428] border border-[#1e1e38] rounded-xl text-sm">
        <span className="text-[#7070a0]">
          <span className="text-[#e8e8f0] font-bold">{stats.total}</span> Total
        </span>
        <span className="text-[#3a3a60]">·</span>
        <span className="text-[#7070a0]">
          <span className="text-brand-mint font-bold">{stats.active}</span> Active
        </span>
        <span className="text-[#3a3a60]">·</span>
        <span className="text-[#7070a0]">
          <span className="text-[#e8e8f0] font-bold">{stats.pending}</span> Pending
        </span>
        <span className="text-[#3a3a60]">·</span>
        <span className="text-[#7070a0]">
          <span className="text-red-400 font-bold">{stats.revoked}</span> Revoked
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        {/* Status filter */}
        <select
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setSelected(new Set()); }}
          className="bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-1.5 text-sm
                     text-[#e8e8f0] focus:outline-none focus:border-[#4a9eff] transition-colors"
        >
          {filterOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <>
            <span className="text-xs text-[#7070a0]">{selected.size} selected</span>
            <button
              onClick={handleBulkRevoke}
              disabled={bulkPending}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white
                         bg-brand-orange hover:bg-[#ff8860] disabled:bg-[#3a3a60]
                         transition-colors"
            >
              {bulkPending ? "Revoking…" : "Revoke Selected"}
            </button>
            {bulkError && <span className="text-brand-orange text-xs">{bulkError}</span>}
          </>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className="px-3 py-3 w-8">
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selected.size === filtered.length}
                  onChange={toggleAll}
                  className="accent-brand-blue"
                />
              </th>
              <th className={TH}>Key</th>
              <th className={TH}>Label</th>
              <th className={TH}>Credits</th>
              <th className={TH}>Bound Device</th>
              <th className={TH}>Status</th>
              <th className={TH}>Activated</th>
              <th className={TH}>Expires</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No licenses match this filter
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const status = effectiveStatus(row);
              const isSelected = selected.has(row.key);

              return (
                <tr
                  key={row.id}
                  className={`transition-colors ${isSelected ? "bg-brand-blue/5" : "hover:bg-[#0f0f1c]"}`}
                >
                  {/* Checkbox */}
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(row.key)}
                      className="accent-brand-blue"
                    />
                  </td>

                  {/* Key */}
                  <td className={TD}>
                    <KeyCell licenseKey={row.key} />
                  </td>

                  {/* Label */}
                  <td className={TD}>
                    <span className="text-xs text-[#e8e8f0]">
                      {row.label ?? <span className="text-[#3a3a60]">—</span>}
                    </span>
                  </td>

                  {/* Credits (inline edit) */}
                  <td className={TD}>
                    <EditCreditsCell licenseKey={row.key} current={row.credits_limit} />
                  </td>

                  {/* Bound device */}
                  <td className={TD}>
                    {row.hardware_id ? (
                      <span className="font-mono text-xs text-[#7070a0]">
                        {row.hardware_id.slice(0, 8)}…
                      </span>
                    ) : (
                      <span className="text-[#3a3a60] text-xs">Not activated</span>
                    )}
                  </td>

                  {/* Status */}
                  <td className={TD}>
                    <StatusBadge status={status} />
                  </td>

                  {/* Activated */}
                  <td className={TD}>
                    <span className="text-xs text-[#7070a0]">{fmtDate(row.activated_at)}</span>
                  </td>

                  {/* Expires */}
                  <td className={TD}>
                    <span className={`text-xs ${
                      row.expires_at && new Date(row.expires_at) < new Date()
                        ? "text-brand-orange"
                        : "text-[#7070a0]"
                    }`}>
                      {fmtDate(row.expires_at)}
                    </span>
                  </td>

                  {/* Actions */}
                  <td className={TD}>
                    <ActionCell row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
