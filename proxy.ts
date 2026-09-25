import { NextRequest, NextResponse } from "next/server";
import { isValidSession } from "@/lib/session-store";

// /api/cron is excluded from the session gate for the same reason
// /api/auth is: Vercel's own cron trigger has no browser session cookie
// to present, only the CRON_SECRET Authorization header the route
// itself checks. Without this exclusion, the trigger would get a 307
// redirect to /login - which Vercel counts as a completed invocation
// (cron jobs do not follow redirects), silently "succeeding" while the
// cleanup never actually ran.
const PUBLIC_PATHS = ["/login", "/api/auth", "/api/cron"];

// The Telegram webhook is public for the same reason /api/cron is: Telegram
// has no admin session cookie, only the X-Telegram-Bot-Api-Secret-Token
// header the route itself verifies (constant-time, before any DB access -
// see lib/telegram/webhook.ts). Matched EXACTLY rather than by prefix so no
// sibling route can ever be made public by accident.
const PUBLIC_EXACT_PATHS = ["/api/telegram/webhook"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_EXACT_PATHS.includes(pathname) || PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = req.cookies.get("admin_auth")?.value ?? "";

  if (!(await isValidSession(token))) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
