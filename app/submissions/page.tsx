import { fetchSubmissions } from "@/lib/queries";
import SubmissionsTable from "@/components/submissions/SubmissionsTable";
import RefreshButton from "@/components/users/RefreshButton";
import type { SubmissionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SubmissionsPage() {
  let submissions: SubmissionRow[];
  let fetchError: string | null = null;

  try {
    submissions = await fetchSubmissions();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    submissions = [];
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
            In-app submissions for revenue share. A video only pays out once you&apos;ve
            manually confirmed the matching Whop submission exists — this table does not
            check Whop for you.
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

      <SubmissionsTable submissions={submissions} />
    </div>
  );
}
