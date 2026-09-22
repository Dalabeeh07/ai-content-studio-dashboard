import { serverClient } from "@/lib/supabase";
import ComposeForm from "@/components/notifications/ComposeForm";
import NotificationsTable, { type RawNotifRow } from "@/components/notifications/NotificationsTable";

export const dynamic = "force-dynamic";

// ── Data fetching ─────────────────────────────────────────────────────────────
//
// user_label is now derived client-side in NotificationsTable (a live
// Realtime INSERT/UPDATE payload only ever carries notifications' own
// granted columns, never a joined users.email) - this just passes the
// raw rows plus a hwid->email map down instead of pre-joining server-side.

async function fetchPageData() {
  const db = serverClient();
  if (!db) return {
    notifs: [] as RawNotifRow[],
    userMap: {} as Record<string, string | null>,
    userOptions: [] as { hardware_id: string; label: string }[],
  };

  // Users (for compose form + recipient labels)
  const { data: usersRaw } = await db
    .from("users")
    .select("hwid, email")
    .order("last_active_at", { ascending: false });

  const users = ((usersRaw ?? []) as { hwid: string; email: string | null }[]);
  const userMap: Record<string, string | null> = Object.fromEntries(users.map((u) => [u.hwid, u.email]));

  // Notifications ordered newest first
  const { data: notifsRaw } = await db
    .from("notifications")
    .select("id, hwid, body, created_at, read")
    .order("created_at", { ascending: false })
    .limit(100);

  const notifs = (notifsRaw ?? []) as RawNotifRow[];

  const userOptions = users.map((u) => ({
    hardware_id: u.hwid,
    label: u.email ?? `User #${u.hwid.slice(0, 6)}`,
  }));

  return { notifs, userMap, userOptions };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function NotificationsPage() {
  let data;
  let fetchError: string | null = null;

  try {
    data = await fetchPageData();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    data = { notifs: [], userMap: {}, userOptions: [] };
  }

  const { notifs, userMap, userOptions } = data;

  return (
    <div className="p-8 min-h-screen bg-[#08080f]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#e8e8f0]">Notifications</h1>
        <p className="text-[#7070a0] text-sm mt-0.5">
          Send in-app messages to your users
        </p>
      </div>

      {fetchError && (
        <div className="mb-6 bg-brand-orange/10 border border-brand-orange/30 text-brand-orange rounded-xl px-5 py-3 text-sm">
          ⚠ {fetchError}
        </div>
      )}

      <div className="flex gap-6 items-start">

        {/* ── Left: Compose ───────────────────────────────────────────── */}
        <div className="w-[40%] shrink-0">
          <div className="bg-[#141428] border border-[#1e1e38] rounded-2xl p-6">
            <h2 className="text-[#e8e8f0] font-bold text-base mb-5">
              Send Notification
            </h2>
            <ComposeForm users={userOptions} />
          </div>
        </div>

        {/* ── Right: History ───────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          <h2 className="text-[#e8e8f0] font-bold text-base mb-3">
            Sent Notifications
          </h2>

          <NotificationsTable notifs={notifs} userMap={userMap} />
        </div>
      </div>
    </div>
  );
}
