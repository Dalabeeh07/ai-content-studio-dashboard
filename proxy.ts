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

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
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
