import crypto from "crypto";
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

// Constant-time password check. ADMIN_PASSWORD stays a plain Vercel
// "Sensitive" env var (already encrypted at rest, never readable back
// once set) - no new storage or migration needed for this half of the
// fix, since the actual gap was never about how the password is stored,
// only how it was compared. `password.trim() !== adminPassword` is a
// plain JS string inequality, which short-circuits at the first
// differing byte - a textbook timing side-channel. Both sides are hashed
// with the same per-request random salt via Node's built-in scrypt (no
// new dependency - bcrypt's native binding has a real history of
// works-locally-fails-on-Vercel platform mismatches, and this app has
// otherwise stayed to 5 total production dependencies), then compared
// with crypto.timingSafeEqual, which is constant-time by design and
// correctly handles the fixed-length scrypt output rather than the
// original variable-length raw strings.
function safeComparePasswords(submitted: string, expected: string): boolean {
  const salt = crypto.randomBytes(16);
  const a = crypto.scryptSync(submitted, salt, 64);
  const b = crypto.scryptSync(expected, salt, 64);
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterMinutes } = await checkRateLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${retryAfterMinutes} minutes.` },
      { status: 429 }
    );
  }

  const { password } = await req.json();
  const adminPassword = (process.env.ADMIN_PASSWORD ?? "").trim();

  if (!adminPassword || !safeComparePasswords((password ?? "").trim(), adminPassword)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await resetRateLimit(ip);
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
