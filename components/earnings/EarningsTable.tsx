"use client";

import { useState, useTransition } from "react";
import { markUserPaid, markUserPending } from "@/app/earnings/actions";
import { ADMIN_SHARE, USER_SHARE } from "@/lib/constants";
import type { EarningsUserRow } from "@/lib/types";

const USER_PCT  = `${(USER_SHARE * 100).toFixed(1)}%`;
const ADMIN_PCT = `${(ADMIN_SHARE * 100).toFixed(1)}%`;

function RowActions({
  row,
  onOptimisticUpdate,
}: {
  row: EarningsUserRow;
  onOptimisticUpdate: (patch: Partial<Pick<EarningsUserRow, "fully_paid">>) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function pay() {
    onOptimisticUpdate({ fully_paid: true });
    setErr("");
    startTransition(async () => {
      const r = await markUserPaid(row.hwid);
      if (!r.ok) {
        onOptimisticUpdate({ fully_paid: false });
        setErr(r.error ?? "Failed");
      }
    });
  }

  function undo() {
    onOptimisticUpdate({ fully_paid: false });
    setErr("");
    startTransition(async () => {
      const r = await markUserPending(row.hwid);
      if (!r.ok) {
        onOptimisticUpdate({ fully_paid: true });
        setErr(r.error ?? "Failed");
      }
    });
  }

  const btnBase =
    "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-col gap-1">
      {row.fully_paid ? (
        <div className="flex gap-1.5 items-center">
          <span className="text-[11px] text-brand-mint font-semibold">✓ Fully paid</span>
          <button
            onClick={undo}
            disabled={pending}
            className={`${btnBase} bg-[#141428] border-[#1e1e38] text-[#7070a0] hover:border-[#7070a0] hover:bg-[#1a1a2e]`}
          >
            Reset to pending
          </button>
        </div>
      ) : (
        <button
          onClick={pay}
          disabled={pending}
          className={`${btnBase} bg-[#0f2a1a] border-brand-mint/40 text-brand-mint hover:bg-brand-mint hover:text-black`}
        >
          Mark ${row.pending_user_share.toFixed(2)} paid
        </button>
      )}
      {err && <span className="text-brand-orange text-[10px]">{err}</span>}
    </div>
  );
}

export default function EarningsTable({ rows: initialRows }: { rows: EarningsUserRow[] }) {
  const [rows, setRows] = useState<EarningsUserRow[]>(initialRows);

  // Sync when server re-renders with fresh data (e.g. after RefreshButton)
  const [lastSeenInitial, setLastSeenInitial] = useState(initialRows);
  if (initialRows !== lastSeenInitial) {
    setLastSeenInitial(initialRows);
    setRows(initialRows);
  }
  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <div>
      <h2 className="text-[#e8e8f0] font-bold text-base mb-3">Per-User Breakdown</h2>
      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className={TH}>User</th>
              <th className={TH}>Gross Earnings</th>
              <th className={TH}>Their Share ({USER_PCT})</th>
              <th className={TH}>Admin Share ({ADMIN_PCT})</th>
              <th className={TH}>Clips</th>
              <th className={TH}>Payout</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                  No clips with earnings yet
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const displayName = r.user_email ?? `User #${r.hwid.slice(0, 6)}`;

              return (
                <tr key={r.hwid} className="hover:bg-[#0f0f1c] transition-colors">
                  <td className={TD}>
                    <span className="text-[#e8e8f0] font-medium">{displayName}</span>
                  </td>
                  <td className={TD}>
                    <span className="text-[#e8e8f0] tabular-nums font-semibold">
                      ${r.gross_earnings.toFixed(2)}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="text-brand-mint tabular-nums font-bold">
                      ${r.user_share.toFixed(2)}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="text-brand-yellow tabular-nums font-semibold">
                      ${r.admin_share.toFixed(2)}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="text-[#7070a0] tabular-nums">
                      {r.published_clips}
                    </span>
                  </td>
                  <td className={TD}>
                    <RowActions
                      row={r}
                      onOptimisticUpdate={(patch) =>
                        setRows((prev) =>
                          prev.map((x) => (x.hwid === r.hwid ? { ...x, ...patch } : x))
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>

          {rows.length > 0 && (
            <tfoot className="bg-[#0f0f1c] border-t border-[#1e1e38]">
              <tr>
                <td className={`${TD} text-[#7070a0] font-semibold`}>
                  Total ({rows.length} users)
                </td>
                <td className={`${TD} text-[#e8e8f0] tabular-nums font-bold`}>
                  ${rows.reduce((s, r) => s + r.gross_earnings, 0).toFixed(2)}
                </td>
                <td className={`${TD} text-brand-mint tabular-nums font-bold`}>
                  ${rows.reduce((s, r) => s + r.user_share, 0).toFixed(2)}
                </td>
                <td className={`${TD} text-brand-yellow tabular-nums font-bold`}>
                  ${rows.reduce((s, r) => s + r.admin_share, 0).toFixed(2)}
                </td>
                <td className={`${TD} text-[#7070a0] tabular-nums`}>
                  {rows.reduce((s, r) => s + r.published_clips, 0)}
                </td>
                <td className={TD} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
