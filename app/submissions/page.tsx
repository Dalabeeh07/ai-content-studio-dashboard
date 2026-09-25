import { parsePageParams, sanitizeFilters } from "@/lib/submissions/filters";
import {
  fetchCampaignOptions, fetchPendingCounts, fetchSubmissionsPage,
  type CampaignOption, type SubmissionsPage,
} from "@/lib/submissions/query";
import SubmissionsTable from "@/components/submissions/SubmissionsTable";
import RefreshButton from "@/components/users/RefreshButton";
import type { PendingCount } from "@/lib/types";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  // Everything the page shows is derived from the URL, re-validated here:
  // the query string is untrusted input.
  const filters = sanitizeFilters(sp);
  const { page, size } = parsePageParams(sp);

  let data: SubmissionsPage | null = null;
  let campaigns: CampaignOption[] = [];
  let pending: PendingCount[] = [];
  let fetchError: string | null = null;

  try {
    campaigns = await fetchCampaignOptions();
    [data, pending] = await Promise.all([
      fetchSubmissionsPage(filters, page, size),
      fetchPendingCounts(campaigns),
    ]);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    if (/schema cache|does not exist|could not find/i.test(fetchError) && !/migration 041/i.test(fetchError)) {
      fetchError += " - has migration 041_telegram_link_intake.sql been applied in the Supabase SQL Editor?";
    }
  }

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">Video Submissions</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">
            Links from the desktop app and from the Telegram bot (@PlovikaLinksBot). Telegram
            links are the ones you submit to Whop by hand — use the filters, copy the pending
            links per campaign, then mark them as submitted. This page does not check Whop for you.
          </p>
          <p className="text-[#3a3a60] text-xs mt-0.5">
            Review status only here — actual payment happens on the{" "}
            <a href="/earnings" className="text-brand-blue hover:underline">Earnings</a> page.
          </p>
          <p className="text-[#3a3a60] text-xs mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load submissions: {fetchError}
        </div>
      )}

      {data && (
        <SubmissionsTable
          rows={data.rows}
          total={data.total}
          page={data.page}
          size={data.size}
          asOf={data.asOf}
          filters={filters}
          campaigns={campaigns}
          pending={pending}
        />
      )}
    </div>
  );
}
