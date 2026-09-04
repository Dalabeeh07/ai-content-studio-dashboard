"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Send notification ─────────────────────────────────────────────────────────

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
      .insert({ hwid, body: message.trim() });
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

  if (users.length === 0) {
    revalidatePath("/notifications");
    return { ok: true, recipientCount: 0 };
  }

  const rows = (users as { hardware_id: string }[]).map((u) => ({
    hwid: u.hardware_id,
    body: message.trim(),
  }));

  const { error: bulkErr } = await db.from("notifications").insert(rows);
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

  const { error } = await db
    .from("notifications")
    .delete()
    .eq("id", notifId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/notifications");
  return { ok: true };
}
