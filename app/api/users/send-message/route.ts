import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { hardware_id, title, body, type, action_url } = await req.json();

  if (!hardware_id || !title || !body || !type) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const db = serverClient();

  // Insert global notification
  const { data: notif, error: nErr } = await db
    .from("notifications")
    .insert({ type, title, body, action_url: action_url || null })
    .select("id")
    .single();

  if (nErr || !notif) {
    return NextResponse.json({ error: nErr?.message ?? "Insert failed" }, { status: 500 });
  }

  // Link to this user
  const { error: unErr } = await db
    .from("user_notifications")
    .insert({ hardware_id, notification_id: notif.id });

  if (unErr) {
    return NextResponse.json({ error: unErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notification_id: notif.id });
}
