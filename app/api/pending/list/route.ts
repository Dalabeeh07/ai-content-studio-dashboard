import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function GET() {
  const db = serverClient();
  if (!db) return NextResponse.json([]);

  // license_key was never a real column on this table (confirmed live -
  // pending_users has no such column) and nothing ever wrote or joined
  // one in - not the signup flow, not the approve/reject action. Removed
  // rather than joined against licenses: a signup's hwid can carry many
  // license rows (dev/test hwids show a dozen+, active and revoked mixed)
  // with no reliable single association to "the" key for a given request.
  const { data, error } = await db
    .from("pending_users")
    .select(
      "id, hwid, full_name, whop_username, social_accounts, " +
      "gemini_key_hint, status, created_at:registered_at, reviewed_at"
    )
    .order("registered_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json([], { status: 500 });
  return NextResponse.json(data ?? []);
}
