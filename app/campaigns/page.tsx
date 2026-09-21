import {
  fetchCampaigns, fetchCampaignHooks, fetchCampaignHookStatuses,
  fetchCampaignVideos, fetchCampaignClips, fetchCampaignCompliance,
} from "@/lib/queries";
import RefreshButton from "@/components/users/RefreshButton";
import CampaignsPanel from "@/components/campaigns/CampaignsPanel";
import type {
  Campaign, CampaignClip, CampaignCompliance, CampaignHook,
  CampaignHookStatusRow, CampaignVideo,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign: selectedId } = await searchParams;

  let campaigns: Campaign[];
  let hookStatuses: CampaignHookStatusRow[];
  let fetchError: string | null = null;
  try {
    campaigns = await fetchCampaigns();
    hookStatuses = await fetchCampaignHookStatuses();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    campaigns = [];
    hookStatuses = [];
  }

  const activeId = selectedId ?? campaigns[0]?.id ?? null;

  let hooks: CampaignHook[] = [];
  let videos: CampaignVideo[] = [];
  let clips: CampaignClip[] = [];
  let compliance: CampaignCompliance = { openedCount: 0, exportedCount: 0, log: [] };
  if (activeId && !fetchError) {
    try {
      hooks = await fetchCampaignHooks(activeId);
      videos = await fetchCampaignVideos(activeId);
      clips = await fetchCampaignClips(activeId);
      compliance = await fetchCampaignCompliance(activeId);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : "Unknown error";
    }
  }

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">Campaigns</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">
            Open to every user - upload and analyze source videos here, then people browse,
            preview, and export the produced clips. Each hook is genuinely one-time-use - once
            exported, it&apos;s claimed and never selected again.
          </p>
          <p className="text-[#3a3a60] text-xs mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load campaigns: {fetchError}
        </div>
      )}

      <CampaignsPanel
        campaigns={campaigns}
        activeId={activeId}
        hooks={hooks}
        hookStatuses={hookStatuses}
        videos={videos}
        clips={clips}
        compliance={compliance}
      />
    </div>
  );
}
