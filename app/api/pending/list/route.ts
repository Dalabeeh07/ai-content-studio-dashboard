import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function GET() {
  const db = serverClient();
  if (!db) return NextResponse.json([]);

  const { data, error } = await db
    .from("pending_users")
    .select("id, email, hwid, status, registered_at, reviewed_at, reject_reason")
    .order("registered_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json([], { status: 500 });
  return NextResponse.json(data ?? []);
}
