import { fetchClips } from "@/lib/queries";
import ClipsTable from "@/components/clips/ClipsTable";
import RefreshButton from "@/components/users/RefreshButton";
import type { ClipRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
  let clips: ClipRow[];
  let fetchError: string | null = null;

  try {
    clips = await fetchClips();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    clips = [];
  }

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">All Clips</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load clips: {fetchError}
        </div>
      )}

      <ClipsTable clips={clips} />
    </div>
  );
}
