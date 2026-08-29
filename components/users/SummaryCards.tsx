import type { SummaryStats } from "@/lib/types";

interface Props {
  stats: SummaryStats;
}

function Card({
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

export default function SummaryCards({ stats }: Props) {
  return (
    <div className="flex gap-4 flex-wrap">
      <Card
        label="Total Users"
        value={stats.total_users.toLocaleString()}
        accent="text-brand-blue"
      />
      <Card
        label="Active Today"
        value={stats.active_today.toLocaleString()}
        accent="text-brand-mint"
        sub="last 24 hours"
      />
      <Card
        label="Total Clips Exported"
        value={stats.total_clips.toLocaleString()}
        accent="text-brand-blue"
      />
      <Card
        label="Est. Total Earnings"
        value={`$${stats.total_earnings.toFixed(2)}`}
        accent="text-brand-mint"
        sub="last 30 days"
      />
    </div>
  );
}
