import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { license_key } = await req.json();

  if (!license_key) {
    return NextResponse.json({ error: "Missing license_key" }, { status: 400 });
  }

  const db = serverClient();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 503 });
  }

  const { error } = await db
    .from("licenses")
    .update({ status: "revoked" })
    .eq("key", license_key);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
