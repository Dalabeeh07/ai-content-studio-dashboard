import { fetchEarnings } from "@/lib/queries";
import MonthlyChart from "@/components/earnings/MonthlyChart";
import RefreshButton from "@/components/users/RefreshButton";

export const dynamic = "force-dynamic";

function StatCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent: string;
  sub?: string;
}) {
  return (
    <div className="flex-1 min-w-0 bg-[#141428] border border-[#1e1e38] rounded-xl px-6 py-5">
      <p className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</p>
      <p className="text-[#7070a0] text-sm mt-1">{label}</p>
      {sub && <p className="text-[#3a3a60] text-xs mt-0.5">{sub}</p>}
    </div>
  );
}

export default async function EarningsPage() {
  let data;
  let fetchError: string | null = null;

  try {
    data = await fetchEarnings();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    data = {
      rows: [],
      monthly: [],
      totals: { gross: 0, userShare: 0, adminShare: 0 },
    };
  }

  const { rows, monthly, totals } = data;

  // "Pending payouts" = sum of user shares for clips not yet confirmed paid
  // For now: same as total user share (no paid tracking in schema yet)
  const pendingPayouts = totals.userShare;

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">Earnings Breakdown</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {/* Error */}
      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load earnings: {fetchError}
        </div>
      )}

      {/* Summary cards */}
      <div className="flex gap-4 flex-wrap">
        <StatCard
          label="Total Revenue"
          value={`$${totals.gross.toFixed(2)}`}
          accent="text-[#e8e8f0]"
          sub="gross estimated"
        />
        <StatCard
          label="Admin Share (40%)"
          value={`$${totals.adminShare.toFixed(2)}`}
          accent="text-brand-yellow"
          sub="your revenue"
        />
        <StatCard
          label="Users' Total (60%)"
          value={`$${totals.userShare.toFixed(2)}`}
          accent="text-brand-mint"
          sub="owed to creators"
        />
        <StatCard
          label="Pending Payouts"
          value={`$${pendingPayouts.toFixed(2)}`}
          accent="text-brand-orange"
          sub="unpaid user share"
        />
      </div>

      {/* Monthly chart */}
      <MonthlyChart bars={monthly} />

      {/* Per-user earnings table */}
      <div>
        <h2 className="text-[#e8e8f0] font-bold text-base mb-3">Per-User Breakdown</h2>
        <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
          <table className="w-full border-collapse">
            <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
              <tr>
                <th className={TH}>User</th>
                <th className={TH}>Gross Earnings</th>
                <th className={TH}>Their Share (60%)</th>
                <th className={TH}>Admin Share (40%)</th>
                <th className={TH}>Clips</th>
              </tr>
            </thead>
            <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-[#7070a0] text-sm">
                    No clips with earnings yet
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const displayName = r.user_email ?? `User #${r.hwid.slice(0, 6)}`;

                return (
                  <tr key={r.hwid} className="hover:bg-[#0f0f1c] transition-colors">
                    {/* Username */}
                    <td className={TD}>
                      <span className="text-[#e8e8f0] font-medium">{displayName}</span>
                    </td>

                    {/* Gross */}
                    <td className={TD}>
                      <span className="text-[#e8e8f0] tabular-nums font-semibold">
                        ${r.gross_earnings.toFixed(2)}
                      </span>
                    </td>

                    {/* User share — mint */}
                    <td className={TD}>
                      <span className="text-brand-mint tabular-nums font-bold">
                        ${r.user_share.toFixed(2)}
                      </span>
                    </td>

                    {/* Admin share — yellow */}
                    <td className={TD}>
                      <span className="text-brand-yellow tabular-nums font-semibold">
                        ${r.admin_share.toFixed(2)}
                      </span>
                    </td>

                    {/* Published clips */}
                    <td className={TD}>
                      <span className="text-[#7070a0] tabular-nums">
                        {r.published_clips}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* Totals footer */}
            {rows.length > 0 && (
              <tfoot className="bg-[#0f0f1c] border-t border-[#1e1e38]">
                <tr>
                  <td className={`${TD} text-[#7070a0] font-semibold`}>
                    Total ({rows.length} users)
                  </td>
                  <td className={`${TD} text-[#e8e8f0] tabular-nums font-bold`}>
                    ${totals.gross.toFixed(2)}
                  </td>
                  <td className={`${TD} text-brand-mint tabular-nums font-bold`}>
                    ${totals.userShare.toFixed(2)}
                  </td>
                  <td className={`${TD} text-brand-yellow tabular-nums font-bold`}>
                    ${totals.adminShare.toFixed(2)}
                  </td>
                  <td className={`${TD} text-[#7070a0] tabular-nums`}>
                    {rows.reduce((s, r) => s + r.published_clips, 0)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Data note */}
      <p className="text-[#3a3a60] text-xs border-t border-[#1e1e38] pt-4">
        Earnings are estimated based on $1.50 per 1,000 views average.
        Actual Whop payouts may differ. Update view counts from the{" "}
        <a href="/clips" className="text-[#7070a0] hover:text-brand-blue transition-colors underline">
          Clips page
        </a>.
      </p>
    </div>
  );
}
