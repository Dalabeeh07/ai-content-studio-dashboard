import { serverClient } from "@/lib/supabase";
import ComposeForm from "@/components/notifications/ComposeForm";
import DeleteButton from "@/components/notifications/DeleteButton";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string;
  action_url: string | null;
  created_at: string;
  expires_at: string | null;
  recipient_count: number;   // computed
  recipient_label: string;   // "All (N)" or "@username"
}

interface ActivityRow {
  id: string;
  hardware_id: string | null;
  read_at: string | null;
  created_at: string;
  notif_title: string;
  username: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, string> = {
  message:  "📢",
  update:   "🔄",
  campaign: "💰",
};

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
  if (!db) return { notifs: [] as NotifRow[], activity: [] as ActivityRow[], userOptions: [] as { hardware_id: string; label: string }[], totalUsers: 0 };

  // Users (for compose form + recipient labels)
  const { data: usersRaw } = await db
    .from("users")
    .select("hardware_id, whop_username")
    .order("last_active_at", { ascending: false });

  const users = ((usersRaw ?? []) as { hardware_id: string; whop_username: string | null }[]);
  const userMap = new Map(users.map((u) => [u.hardware_id, u.whop_username]));
  const totalUsers = users.length;

  // Notifications ordered newest first
  const { data: notifsRaw } = await db
    .from("notifications")
    .select("id, type, title, body, action_url, created_at, expires_at")
    .order("created_at", { ascending: false });

  const notifIds = ((notifsRaw ?? []) as { id: string }[]).map((n) => n.id);

  // Recipient counts per notification
  const recipientMap: Record<string, { count: number; hwids: string[] }> = {};
  if (notifIds.length > 0) {
    const { data: unRaw } = await db
      .from("user_notifications")
      .select("notification_id, hardware_id")
      .in("notification_id", notifIds);

    for (const row of (unRaw ?? []) as { notification_id: string; hardware_id: string | null }[]) {
      const nid = row.notification_id;
      if (!recipientMap[nid]) recipientMap[nid] = { count: 0, hwids: [] };
      recipientMap[nid].count += 1;
      if (row.hardware_id) recipientMap[nid].hwids.push(row.hardware_id);
    }
  }

  const notifs: NotifRow[] = ((notifsRaw ?? []) as {
    id: string; type: string; title: string; body: string;
    action_url: string | null; created_at: string; expires_at: string | null;
  }[]).map((n) => {
    const rec = recipientMap[n.id];
    const count = rec?.count ?? 0;
    let label = "No recipients";
    if (count === totalUsers && totalUsers > 0) {
      label = `All (${count} users)`;
    } else if (count === 1 && rec?.hwids[0]) {
      const un = userMap.get(rec.hwids[0]);
      label = un ? `@${un}` : `#${rec.hwids[0].slice(0, 6)}`;
    } else if (count > 1) {
      label = `${count} users`;
    }
    return { ...n, recipient_count: count, recipient_label: label };
  });

  // Recent activity: last 10 user_notification reads, newest first
  const { data: activityRaw } = await db
    .from("user_notifications")
    .select("id, hardware_id, read_at, created_at, notification_id, notifications(title)")
    .order("created_at", { ascending: false })
    .limit(10);

  const activity: ActivityRow[] = ((activityRaw ?? []) as {
    id: string;
    hardware_id: string | null;
    read_at: string | null;
    created_at: string;
    notification_id: string;
    notifications: { title: string } | { title: string }[] | null;
  }[]).map((a) => {
    const nRow = Array.isArray(a.notifications) ? a.notifications[0] : a.notifications;
    const username = a.hardware_id ? (userMap.get(a.hardware_id) ?? null) : null;
    return {
      id:          a.id,
      hardware_id: a.hardware_id,
      read_at:     a.read_at,
      created_at:  a.created_at,
      notif_title: nRow?.title ?? "(deleted)",
      username,
    };
  });

  const userOptions = users.map((u) => ({
    hardware_id: u.hardware_id,
    label: u.whop_username ? `@${u.whop_username}` : `User #${u.hardware_id.slice(0, 6)}`,
  }));

  return { notifs, activity, userOptions, totalUsers };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function NotificationsPage() {
  let data;
  let fetchError: string | null = null;

  try {
    data = await fetchPageData();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error";
    data = { notifs: [], activity: [], userOptions: [], totalUsers: 0 };
  }

  const { notifs, activity, userOptions } = data;

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  return (
    <div className="p-8 min-h-screen bg-[#08080f]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#e8e8f0]">Notifications</h1>
        <p className="text-[#7070a0] text-sm mt-0.5">
          Send in-app notifications to your users
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
              Compose Notification
            </h2>
            <ComposeForm users={userOptions} />
          </div>
        </div>

        {/* ── Right: History + Activity ────────────────────────────────── */}
        <div className="flex-1 flex flex-col gap-5 min-w-0">

          {/* Sent history */}
          <div>
            <h2 className="text-[#e8e8f0] font-bold text-base mb-3">
              Sent Notifications
            </h2>

            {notifs.length === 0 ? (
              /* Empty state */
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
                      <th className={TH}>Type</th>
                      <th className={TH}>Title</th>
                      <th className={TH}>Sent</th>
                      <th className={TH}>Recipients</th>
                      <th className={TH}>Expires</th>
                      <th className={TH}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
                    {notifs.map((n) => {
                      const expired = n.expires_at && new Date(n.expires_at) < new Date();
                      return (
                        <tr key={n.id} className="hover:bg-[#0f0f1c] transition-colors">
                          {/* Type */}
                          <td className={TD}>
                            <span className="text-base" title={n.type}>
                              {TYPE_ICONS[n.type] ?? "📢"}
                            </span>
                          </td>

                          {/* Title + body snippet */}
                          <td className={TD}>
                            <p className="text-[#e8e8f0] font-medium text-xs leading-tight">
                              {n.title}
                            </p>
                            <p className="text-[#7070a0] text-[11px] mt-0.5 max-w-[200px] truncate">
                              {n.body}
                            </p>
                          </td>

                          {/* Sent */}
                          <td className={TD}>
                            <span className="text-[#7070a0] text-xs">
                              {fmtDate(n.created_at)}
                            </span>
                          </td>

                          {/* Recipients */}
                          <td className={TD}>
                            <span className="text-[#e8e8f0] text-xs">{n.recipient_label}</span>
                          </td>

                          {/* Expires */}
                          <td className={TD}>
                            {n.expires_at ? (
                              <span className={`text-xs ${expired ? "text-brand-orange" : "text-[#7070a0]"}`}>
                                {expired ? "Expired " : ""}{fmtDate(n.expires_at)}
                              </span>
                            ) : (
                              <span className="text-[#3a3a60] text-xs">Never</span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className={TD}>
                            <DeleteButton notifId={n.id} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent activity */}
          {activity.length > 0 && (
            <div>
              <h2 className="text-[#e8e8f0] font-bold text-base mb-3">
                Recent Activity
              </h2>
              <div className="bg-[#141428] border border-[#1e1e38] rounded-xl divide-y divide-[#1e1e38]">
                {activity.map((a) => {
                  const userName = a.username
                    ? `@${a.username}`
                    : a.hardware_id
                      ? `User #${a.hardware_id.slice(0, 6)}`
                      : "Unknown";
                  const verb = a.read_at ? "read" : "received";
                  const when = relTime(a.read_at ?? a.created_at);

                  return (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                      {/* Dot */}
                      <span className={`w-2 h-2 rounded-full shrink-0 ${a.read_at ? "bg-brand-mint" : "bg-[#3a3a60]"}`} />

                      <p className="text-sm text-[#e8e8f0] min-w-0 truncate">
                        <span className="font-semibold">{userName}</span>
                        <span className="text-[#7070a0]"> {verb} </span>
                        <span className="text-brand-blue">&#8220;{a.notif_title}&#8221;</span>
                        <span className="text-[#3a3a60]"> — {when}</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
