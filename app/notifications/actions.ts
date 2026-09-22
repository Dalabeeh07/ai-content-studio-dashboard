"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Send notification ─────────────────────────────────────────────────────────
//
// notifications.title is NOT NULL with no default, but neither this
// dashboard nor the desktop app's notification view ever reads it (the
// desktop app's get_notifications doesn't even select the column) - a
// fixed placeholder satisfies the constraint without adding a compose-UI
// field for a value nothing displays.

export async function sendNotification(formData: FormData): Promise<{
  ok: boolean;
  recipientCount?: number;
  error?: string;
}> {
  const message = formData.get("message") as string;
  const target  = formData.get("target") as string; // "all" | "specific"
  const hwid    = (formData.get("hardware_id") as string) || null;

  if (!message?.trim()) {
    return { ok: false, error: "Message is required." };
  }

  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  if (target === "specific") {
    if (!hwid) {
      return { ok: false, error: "Select a user for specific targeting." };
    }
    const { error } = await db
      .from("notifications")
      .insert({ hwid, title: "Notification", body: message.trim() });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/notifications");
    return { ok: true, recipientCount: 1 };
  }

  // All users
  // users' real column is hardware_id (see lib/queries.ts fetchUsers for
  // the same mismatch) - notifications' own hwid column is unaffected.
  const { data: users, error: uErr } = await db
    .from("users")
    .select("hardware_id");

  if (uErr || !users) {
    return { ok: false, error: uErr?.message ?? "Failed to fetch users." };
  }

  // notifications.hwid is NOT NULL - a user row with no hardware_id (seen
  // live in production) can't be delivered to anyway, and left in would
  // fail the whole batch insert, not just that one row.
  const targetable = (users as { hardware_id: string | null }[]).filter((u) => u.hardware_id);

  if (targetable.length === 0) {
    revalidatePath("/notifications");
    return { ok: true, recipientCount: 0 };
  }

  const rows = targetable.map((u) => ({
    hwid: u.hardware_id as string,
    title: "Notification",
    body: message.trim(),
  }));

  const { error: bulkErr } = await db.from("notifications").insert(rows);
  if (bulkErr) return { ok: false, error: bulkErr.message };

  revalidatePath("/notifications");
  return { ok: true, recipientCount: targetable.length };
}

// ── Delete notification ───────────────────────────────────────────────────────

export async function deleteNotification(notifId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("notifications")
    .delete()
    .eq("id", notifId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/notifications");
  return { ok: true };
}
