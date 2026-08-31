import { serverClient } from "@/lib/supabase";
import ComposeForm from "@/components/notifications/ComposeForm";
import DeleteButton from "@/components/notifications/DeleteButton";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotifRow {
  id: string;
  hwid: string;
  message: string;
  created_at: string;
  read: boolean;
  user_label: string;   // derived
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 2)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchPageData() {
  const db = serverClient();
  if (!db) return {
    notifs: [] as NotifRow[],
    userOptions: [] as { hardware_id: string; label: string }[],
  };

  // Users (for compose form + recipient labels)
  const { data: usersRaw } = await db
    .from("users")
    .select("hwid, email")
    .order("last_active_at", { ascending: false });

  const users = ((usersRaw ?? []) as { hwid: string; email: string | null }[]);
  const userMap = new Map(users.map((u) => [u.hwid, u.email]));

  // Notifications ordered newest first
  const { data: notifsRaw } = await db
    .from("notifications")
    .select("id, hwid, message, created_at, read")
    .order("created_at", { ascending: false })
    .limit(100);

  const notifs: NotifRow[] = ((notifsRaw ?? []) as {
    id: string; hwid: string; message: string; created_at: string; read: boolean;
  }[]).map((n) => {
    const email = userMap.get(n.hwid);
    const user_label = email ?? `User #${n.hwid.slice(0, 6)}`;
    return { ...n, user_label };
  });

  const userOptions = users.map((u) => ({
    hardware_id: u.hwid,
    label: u.email ?? `User #${u.hwid.slice(0, 6)}`,
  }));

  return { notifs, userOptions };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function NotificationsPage() {
  let data;
  let fetchError: string | null = null;

  try {
    data = await fetchPageData();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    data = { notifs: [], userOptions: [] };
  }

  const { notifs, userOptions } = data;

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

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

          {notifs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16
                            bg-[#141428] border border-[#1e1e38] rounded-2xl text-center">
              <div className="text-5xl mb-4 opacity-30">🔔</div>
              <p className="text-[#e8e8f0] font-semibold text-sm">No notifications sent yet</p>
              <p className="text-[#7070a0] text-xs mt-1">
                Use the compose form to send your first notification.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
              <table className="w-full border-collapse">
                <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
                  <tr>
                    <th className={TH}>Recipient</th>
                    <th className={TH}>Message</th>
                    <th className={TH}>Sent</th>
                    <th className={TH}>Read</th>
                    <th className={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
                  {notifs.map((n) => (
                    <tr key={n.id} className="hover:bg-[#0f0f1c] transition-colors">
                      {/* Recipient */}
                      <td className={TD}>
                        <span className="text-[#e8e8f0] text-xs font-medium">{n.user_label}</span>
                      </td>

                      {/* Message */}
                      <td className={TD}>
                        <p className="text-[#e8e8f0] text-xs max-w-[260px] truncate" title={n.message}>
                          {n.message}
                        </p>
                      </td>

                      {/* Sent */}
                      <td className={TD}>
                        <span className="text-[#7070a0] text-xs" title={n.created_at}>
                          {fmtDate(n.created_at)}
                          <br />
                          <span className="text-[#3a3a60]">{relTime(n.created_at)}</span>
                        </span>
                      </td>

                      {/* Read */}
                      <td className={TD}>
                        <span className={`text-xs font-medium ${n.read ? "text-brand-mint" : "text-[#3a3a60]"}`}>
                          {n.read ? "Read" : "Unread"}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className={TD}>
                        <DeleteButton notifId={n.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
