import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function GET() {
  const db = serverClient();
  if (!db) return NextResponse.json({ count: 0 });

  const { count, error } = await db
    .from("pending_users")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  if (error) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: count ?? 0 });
}
