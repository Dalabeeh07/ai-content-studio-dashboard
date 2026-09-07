"use client";

import { useTransition } from "react";
import { markUserPaid, markUserPending } from "@/app/earnings/actions";
import { ADMIN_SHARE, USER_SHARE } from "@/lib/constants";
import type { EarningsUserRow } from "@/lib/types";

const USER_PCT  = `${(USER_SHARE * 100).toFixed(1)}%`;
const ADMIN_PCT = `${(ADMIN_SHARE * 100).toFixed(1)}%`;

function RowActions({ row }: { row: EarningsUserRow }) {
  const [pending, startTransition] = useTransition();

  function pay() {
    startTransition(async () => {
      await markUserPaid(row.hwid);
    });
  }

  function undo() {
    startTransition(async () => {
      await markUserPending(row.hwid);
    });
  }

  const btnBase =
    "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  if (row.fully_paid) {
    return (
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
    );
  }

  return (
    <button
      onClick={pay}
      disabled={pending}
      className={`${btnBase} bg-[#0f2a1a] border-brand-mint/40 text-brand-mint hover:bg-brand-mint hover:text-black`}
    >
      Mark ${row.pending_user_share.toFixed(2)} paid
    </button>
  );
}

export default function EarningsTable({ rows }: { rows: EarningsUserRow[] }) {
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
                    <RowActions row={r} />
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
