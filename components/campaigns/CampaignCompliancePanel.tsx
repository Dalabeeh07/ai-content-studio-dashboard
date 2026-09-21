"use client";

import type { CampaignCompliance } from "@/lib/types";

// Compliance/stats view (migration 028's campaign_terms_log/campaign_exports):
// who has opened+agreed to this campaign's terms, and how many clips it's
// produced in exports overall. Deliberately does NOT show which user
// exported which specific clip - the founder said that granularity isn't
// needed, and no Realtime grant exists here (this data only ever refreshes
// via RefreshButton/revalidatePath, matching migration 029's own scoping).

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function CampaignCompliancePanel({ compliance }: { compliance: CampaignCompliance }) {
  const { openedCount, exportedCount, log } = compliance;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1 p-4 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">
            People who opened this campaign
          </span>
          <span className="text-2xl font-bold text-[#e8e8f0]">{openedCount.toLocaleString()}</span>
        </div>
        <div className="flex flex-col gap-1 p-4 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">
            Clips exported overall
          </span>
          <span className="text-2xl font-bold text-[#e8e8f0]">{exportedCount.toLocaleString()}</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">User</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Device ID</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Accepted terms at</th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {log.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-[#7070a0] text-sm">
                  No one has opened this campaign yet.
                </td>
              </tr>
            )}
            {log.map((row) => (
              <tr key={row.id} className="hover:bg-[#0f0f1c] transition-colors">
                <td className="px-4 py-2.5 text-sm text-[#e8e8f0]">{row.user_email ?? "—"}</td>
                <td className="px-4 py-2.5 text-xs text-[#7070a0] font-mono">{row.hwid.slice(0, 12)}…</td>
                <td className="px-4 py-2.5 text-xs text-[#7070a0]">{fmtDateTime(row.accepted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
