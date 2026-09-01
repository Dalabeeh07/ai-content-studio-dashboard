import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function GET() {
  const db = serverClient();
  if (!db) return NextResponse.json([]);

  const { data, error } = await db
    .from("pending_users")
    .select(
      "id, hwid, full_name, whop_username, license_key, social_accounts, " +
      "gemini_key_hint, status, created_at:registered_at, reviewed_at"
    )
    .order("registered_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json([], { status: 500 });
  return NextResponse.json(data ?? []);
}
