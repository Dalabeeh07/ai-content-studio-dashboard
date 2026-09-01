import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { hwid, body: messageBody } = await req.json();

  if (!hwid || !messageBody) {
    return NextResponse.json({ error: "Missing fields: hwid and body are required" }, { status: 400 });
  }

  const db = serverClient();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 503 });
  }

  const { error } = await db
    .from("notifications")
    .insert({ hwid, body: messageBody, read: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
