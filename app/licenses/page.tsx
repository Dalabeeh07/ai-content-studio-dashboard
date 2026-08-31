import { serverClient } from "@/lib/supabase";
import GenerateForm from "@/components/licenses/GenerateForm";
import LicensesTable from "@/components/licenses/LicensesTable";
import type { LicenseRow } from "@/components/licenses/LicensesTable";
import RefreshButton from "@/components/users/RefreshButton";

export const dynamic = "force-dynamic";

async function fetchLicenses(): Promise<LicenseRow[]> {
  const db = serverClient();
  if (!db) return [];

  const { data, error } = await db
    .from("licenses")
    .select("id, key, label, credits_limit, hardware_id, status, activated_at, created_at, expires_at")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as {
    id: string;
    key: string;
    label: string | null;
    credits_limit: number;
    hardware_id: string | null;
    status: "active" | "expired" | "revoked";
    activated_at: string | null;
    created_at: string;
    expires_at: string | null;
  }[]).map((r) => ({
    id:            r.id,
    key:           r.key,
    label:         r.label,
    credits_limit: r.credits_limit,
    hardware_id:   r.hardware_id,
    status:        r.status,
    activated_at:  r.activated_at,
    created_at:    r.created_at,
    expires_at:    r.expires_at,
  }));
}

export default async function LicensesPage() {
  let licenses: LicenseRow[];
  let fetchError: string | null = null;

  try {
    licenses = await fetchLicenses();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    licenses = [];
  }

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">License Management</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load licenses: {fetchError}
        </div>
      )}

      {/* Generate form */}
      <GenerateForm />

      {/* Licenses table */}
      <div>
        <h2 className="text-[#e8e8f0] font-bold text-base mb-3">All Licenses</h2>
        <LicensesTable licenses={licenses} />
      </div>
    </div>
  );
}
