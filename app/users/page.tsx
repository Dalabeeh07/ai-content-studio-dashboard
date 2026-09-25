import { fetchUsers, fetchSummary, fetchTelegramStatus } from "@/lib/queries";
import SummaryCards from "@/components/users/SummaryCards";
import UsersTable from "@/components/users/UsersTable";
import RefreshButton from "@/components/users/RefreshButton";
import type { UserRow, SummaryStats, TelegramStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  let users: UserRow[];
  let stats: SummaryStats;
  let fetchError: string | null = null;
  let telegram: Record<string, TelegramStatus> = {};
  let telegramError: string | null = null;

  try {
    users = await fetchUsers();
    stats = await fetchSummary(users);
    ({ byHwid: telegram, error: telegramError } = await fetchTelegramStatus());
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    users = [];
    stats = { total_users: 0, active_today: 0, total_clips: 0, total_earnings: 0 };
  }

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="p-8 flex flex-col gap-6 min-h-screen bg-[#08080f]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8f0]">Users</h1>
          <p className="text-[#7070a0] text-sm mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <RefreshButton />
      </div>

      {fetchError && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 text-brand-orange
                        rounded-xl px-5 py-3 text-sm">
          ⚠ Failed to load data: {fetchError}
        </div>
      )}

      {telegramError && (
        <div className="bg-brand-yellow/10 border border-brand-yellow/30 text-brand-yellow
                        rounded-xl px-5 py-3 text-sm">
          Telegram link status unavailable: {telegramError}. Has migration
          041_telegram_link_intake.sql been applied in the Supabase SQL Editor?
        </div>
      )}

      <SummaryCards stats={stats} />
      <UsersTable users={users} telegram={telegram} />
    </div>
  );
}
