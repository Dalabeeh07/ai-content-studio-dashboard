import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const db = serverClient();
  if (!db) return NextResponse.json({ error: "Not configured" }, { status: 503 });

  const { id } = await params;
  const { action, reject_reason } = await req.json() as {
    action: "approve" | "reject";
    reject_reason?: string;
  };

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const { error } = await db
    .from("pending_users")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      reviewed_at: new Date().toISOString(),
      reject_reason: action === "reject" ? (reject_reason ?? "") : "",
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
