import { fetchEarnings } from "@/lib/queries";
import { ADMIN_SHARE, USER_SHARE } from "@/lib/constants";
import MonthlyChart from "@/components/earnings/MonthlyChart";
import EarningsTable from "@/components/earnings/EarningsTable";
import RefreshButton from "@/components/users/RefreshButton";

const USER_PCT  = `${(USER_SHARE * 100).toFixed(1)}%`;
const ADMIN_PCT = `${(ADMIN_SHARE * 100).toFixed(1)}%`;

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
      totals: { gross: 0, userShare: 0, adminShare: 0, pendingUserShare: 0, paidUserShare: 0 },
    };
  }

  const { rows, monthly, totals } = data;

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

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
          label={`Admin Share (${ADMIN_PCT})`}
          value={`$${totals.adminShare.toFixed(2)}`}
          accent="text-brand-yellow"
          sub="your revenue"
        />
        <StatCard
          label={`Users' Total (${USER_PCT})`}
          value={`$${totals.userShare.toFixed(2)}`}
          accent="text-brand-mint"
          sub="owed to creators"
        />
        <StatCard
          label="Pending Payouts"
          value={`$${totals.pendingUserShare.toFixed(2)}`}
          accent="text-brand-orange"
          sub="unpaid user share"
        />
        <StatCard
          label="Paid Out"
          value={`$${totals.paidUserShare.toFixed(2)}`}
          accent="text-brand-mint"
          sub="confirmed sent"
        />
      </div>

      {/* Monthly chart */}
      <MonthlyChart bars={monthly} />

      {/* Per-user earnings table */}
      <EarningsTable rows={rows} />

      {/* Data note */}
      <p className="text-[#3a3a60] text-xs border-t border-[#1e1e38] pt-4">
        Earnings are estimated based on $1.50 per 1,000 views average.
        Actual Whop payouts may differ. View counts are not currently synced
        automatically from any platform and must be checked manually before
        marking a payout as paid.
      </p>
    </div>
  );
}
