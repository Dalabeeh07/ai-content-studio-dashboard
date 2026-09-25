import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";
import { RETENTION_DAYS } from "@/lib/telegram/config";

// Deletes stale rows from admin_login_attempts and admin_sessions -
// neither table has ever had a cleanup mechanism (confirmed via a full
// grep of this repo: no cron, no vercel.json, nothing). admin_login_
// attempts accumulates one row per distinct IP that ever fails a login
// (bots/scanners included, not just real attackers) forever; admin_
// sessions is only ever cleaned lazily, when that exact expired token
// happens to be presented again (lib/session-store.ts's isValidSession).
// Both are unbounded growth risks, not security holes (both tables are
// fully anon-denied - see migrations 008/038).
//
// Runs on Vercel Cron (vercel.json), once daily - the only frequency
// Hobby-tier cron supports, and daily is more than enough for either
// table's actual growth rate. Deliberately idempotent (delete-by-
// timestamp-comparison has the same effect run once or run twice),
// matching Vercel's own documented cron-delivery guidance - cron
// delivery is best-effort and can occasionally invoke the same run more
// than once or skip one.
//
// Secured the same way Vercel's own docs recommend: a CRON_SECRET env
// var, sent back as `Authorization: Bearer <secret>` by Vercel's own
// cron trigger - never a session cookie, since Vercel's trigger has no
// browser session. This route is listed in proxy.ts's PUBLIC_PATHS for
// exactly that reason (the session gate would otherwise 307-redirect
// the cron trigger to /login, which Vercel would count as a completed,
// "successful" invocation that silently did nothing - the exact
// silent-failure shape this whole audit has been hunting all session).
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = serverClient();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 503 });
  }

  // admin_login_attempts: a row is "stale" once its 15-minute rate-limit
  // window is long over - 1 day of margin, matching the task's own ask,
  // well past any legitimate use of the row.
  const staleAttemptsBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: deletedAttempts, error: attemptsError } = await db
    .from("admin_login_attempts")
    .delete()
    .lt("window_start", staleAttemptsBefore)
    .select("ip");

  // admin_sessions: only ever delete rows that are ACTUALLY expired -
  // this must never touch a still-valid session.
  const nowIso = new Date().toISOString();
  const { data: deletedSessions, error: sessionsError } = await db
    .from("admin_sessions")
    .delete()
    .lt("expires_at", nowIso)
    .select("id");

  // Telegram intake retention (migration 041). tg_cleanup deletes only rows
  // past their retention (see RETENTION_DAYS in lib/telegram/config.ts):
  // telegram_updates 3d, rate-limit windows 2d, picker tokens 1d after expiry,
  // link codes 30d after use/expiry, revoked links 90d. video_submissions
  // themselves are business records and are never touched here. Its failure
  // is reported but does not stop the two cleanups above from having run.
  const { data: telegramDeleted, error: telegramError } = await db.rpc("tg_cleanup", {
    p_updates_days: RETENTION_DAYS.updates,
    p_rate_days: RETENTION_DAYS.rateLimits,
    p_choices_days: RETENTION_DAYS.pendingChoices,
    p_codes_days: RETENTION_DAYS.linkCodes,
    p_links_days: RETENTION_DAYS.revokedLinks,
  });

  if (attemptsError || sessionsError || telegramError) {
    return NextResponse.json(
      { ok: false, error: attemptsError?.message ?? sessionsError?.message ?? telegramError?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      admin_login_attempts: deletedAttempts?.length ?? 0,
      admin_sessions: deletedSessions?.length ?? 0,
      telegram: telegramDeleted ?? {},
    },
  });
}
