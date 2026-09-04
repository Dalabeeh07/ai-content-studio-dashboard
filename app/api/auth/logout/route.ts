import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session-store";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("admin_auth")?.value;
  if (token) await destroySession(token);

  const res = NextResponse.json({ ok: true });
  res.cookies.delete("admin_auth");
  return res;
}
