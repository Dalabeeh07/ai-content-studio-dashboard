"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Send notification ─────────────────────────────────────────────────────────

export async function sendNotification(formData: FormData): Promise<{
  ok: boolean;
  recipientCount?: number;
  error?: string;
}> {
  const type       = formData.get("type") as string;
  const title      = formData.get("title") as string;
  const body       = formData.get("body") as string;
  const action_url = (formData.get("action_url") as string) || null;
  const target     = formData.get("target") as string; // "all" | "specific"
  const hwid       = (formData.get("hardware_id") as string) || null;
  const expiresRaw = (formData.get("expires") as string) || null;

  if (!type || !title || !body) {
    return { ok: false, error: "Type, title and body are required." };
  }

  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  // Insert the notification
  const { data: notif, error: nErr } = await db
    .from("notifications")
    .insert({
      type,
      title,
      body,
      action_url,
      expires_at: expiresRaw ? new Date(expiresRaw).toISOString() : null,
    })
    .select("id")
    .single();

  if (nErr || !notif) {
    return { ok: false, error: nErr?.message ?? "Failed to create notification." };
  }

  const notifId = notif.id as string;

  if (target === "specific") {
    if (!hwid) {
      return { ok: false, error: "Select a user for specific targeting." };
    }
    const { error: unErr } = await db
      .from("user_notifications")
      .insert({ notification_id: notifId, hardware_id: hwid });
    if (unErr) return { ok: false, error: unErr.message };
    revalidatePath("/notifications");
    return { ok: true, recipientCount: 1 };
  }

  // All users
  const { data: users, error: uErr } = await db
    .from("users")
    .select("hardware_id");

  if (uErr || !users) {
    return { ok: false, error: uErr?.message ?? "Failed to fetch users." };
  }

  if (users.length === 0) {
    revalidatePath("/notifications");
    return { ok: true, recipientCount: 0 };
  }

  const rows = (users as { hardware_id: string }[]).map((u) => ({
    notification_id: notifId,
    hardware_id:     u.hardware_id,
  }));

  const { error: bulkErr } = await db.from("user_notifications").insert(rows);
  if (bulkErr) return { ok: false, error: bulkErr.message };

  revalidatePath("/notifications");
  return { ok: true, recipientCount: users.length };
}

// ── Delete notification ───────────────────────────────────────────────────────

export async function deleteNotification(notifId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  // user_notifications rows cascade-delete (FK ON DELETE CASCADE)
  const { error } = await db
    .from("notifications")
    .delete()
    .eq("id", notifId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/notifications");
  return { ok: true };
}
