"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";
import DeleteButton from "@/components/notifications/DeleteButton";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RawNotifRow {
  id: string;
  hwid: string;
  body: string;
  created_at: string;
  read: boolean;
}

interface NotifRow extends RawNotifRow {
  user_label: string; // derived client-side from userMap, same as the
                       // server used to do - a live INSERT/UPDATE payload
                       // only ever carries notifications' own granted
                       // columns, never a joined users.email, so this has
                       // to be computed here rather than passed through.
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

// ── Table ─────────────────────────────────────────────────────────────────────

export default function NotificationsTable({
  notifs: initialNotifs,
  userMap,
}: {
  notifs: RawNotifRow[];
  userMap: Record<string, string | null>;
}) {
  const withLabel = (n: RawNotifRow): NotifRow => ({
    ...n,
    user_label: userMap[n.hwid] ?? `User #${n.hwid.slice(0, 6)}`,
  });

  const [notifs, setNotifs] = useState<NotifRow[]>(initialNotifs.map(withLabel));

  // Prop-sync during render - same pattern as every other table this
  // session (UsersTable.tsx, CampaignsPanel.tsx, LicensesTable.tsx):
  // reconciles a server refetch (e.g. after ComposeForm's own
  // revalidatePath) with whatever Realtime has already applied locally.
  const [lastSeenInitial, setLastSeenInitial] = useState(initialNotifs);
  if (initialNotifs !== lastSeenInitial) {
    setLastSeenInitial(initialNotifs);
    setNotifs(initialNotifs.map(withLabel));
  }

  useEffect(() => {
    const channel = browserClient
      .channel("notifications-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT", schema: "public", table: "notifications",
          select: ["id", "hwid", "body", "created_at", "read"],
        },
        (payload) => {
          const inserted = withLabel(payload.new as RawNotifRow);
          setNotifs((prev) => (prev.some((n) => n.id === inserted.id) ? prev : [inserted, ...prev]));
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE", schema: "public", table: "notifications",
          select: ["id", "hwid", "body", "created_at", "read"],
        },
        (payload) => {
          const updated = payload.new as RawNotifRow;
          setNotifs((prev) => prev.map((n) => (n.id === updated.id ? withLabel(updated) : n)));
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "notifications" },
        (payload) => {
          const deletedId = (payload.old as { id?: string }).id;
          if (deletedId) setNotifs((prev) => prev.filter((n) => n.id !== deletedId));
        }
      )
      .subscribe();

    return () => {
      browserClient.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const TH = "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]";
  const TD = "px-4 py-3 text-sm align-middle";

  if (notifs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16
                      bg-[#141428] border border-[#1e1e38] rounded-2xl text-center">
        <div className="text-5xl mb-4 opacity-30">🔔</div>
        <p className="text-[#e8e8f0] font-semibold text-sm">No notifications sent yet</p>
        <p className="text-[#7070a0] text-xs mt-1">
          Use the compose form to send your first notification.
        </p>
      </div>
    );
  }

  return (
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
              <td className={TD}>
                <span className="text-[#e8e8f0] text-xs font-medium">{n.user_label}</span>
              </td>

              <td className={TD}>
                <p className="text-[#e8e8f0] text-xs max-w-[260px] truncate" title={n.body}>
                  {n.body}
                </p>
              </td>

              <td className={TD}>
                <span className="text-[#7070a0] text-xs" title={n.created_at}>
                  {fmtDate(n.created_at)}
                  <br />
                  <span className="text-[#3a3a60]">{relTime(n.created_at)}</span>
                </span>
              </td>

              <td className={TD}>
                <span className={`text-xs font-medium ${n.read ? "text-brand-mint" : "text-[#3a3a60]"}`}>
                  {n.read ? "Read" : "Unread"}
                </span>
              </td>

              <td className={TD}>
                <DeleteButton
                  notifId={n.id}
                  onOptimisticDelete={() => setNotifs((prev) => prev.filter((x) => x.id !== n.id))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
