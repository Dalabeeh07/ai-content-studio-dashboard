import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { hardware_id, message } = await req.json();

  if (!hardware_id || !message) {
    return NextResponse.json({ error: "Missing fields: hardware_id and message are required" }, { status: 400 });
  }

  const db = serverClient();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 503 });
  }

  const { data: notif, error } = await db
    .from("notifications")
    .insert({ hwid: hardware_id, message })
    .select("id")
    .single();

  if (error || !notif) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notification_id: notif.id });
}
