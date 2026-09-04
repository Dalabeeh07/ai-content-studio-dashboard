import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/session-store";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterMinutes } = checkRateLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${retryAfterMinutes} minutes.` },
      { status: 429 }
    );
  }

  const { password } = await req.json();
  const adminPassword = (process.env.ADMIN_PASSWORD ?? "").trim();

  if (!adminPassword || password.trim() !== adminPassword) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  resetRateLimit(ip);
  const token = await createSession();

  const res = NextResponse.json({ ok: true });
  res.cookies.set("admin_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}
