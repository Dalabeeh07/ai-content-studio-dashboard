import crypto from "crypto";
import { serverClient } from "@/lib/supabase";

// Sessions are persisted in the admin_sessions Supabase table (service key,
// bypasses RLS) rather than a file on disk. The previous file-backed store
// worked around middleware.ts and each app/api route handler compiling as
// separate module graphs (a plain in-memory Map would never see writes from
// the other bundle) - but Vercel's serverless functions have a read-only
// filesystem outside /tmp, and don't reliably persist even /tmp across
// invocations, so a file on disk never actually worked in production
// regardless of runtime. A real table sidesteps both problems at once.
//
// See supabase/migrations/ for the admin_sessions table definition (not
// applied automatically - run it in the Supabase SQL Editor).
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the cookie maxAge
const TABLE = "admin_sessions";

export async function createSession(): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const client = serverClient();
  if (!client) {
    console.error("session-store: SUPABASE_SERVICE_KEY not configured - session will not persist");
    return token;
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error } = await client
    .from(TABLE)
    .insert({ id: token, data: {}, expires_at: expiresAt });
  if (error) {
    console.error("session-store: failed to persist session:", error.message);
  }
  return token;
}

export async function isValidSession(token: string): Promise<boolean> {
  if (!token) return false;
  const client = serverClient();
  if (!client) return false;

  const { data, error } = await client
    .from(TABLE)
    .select("expires_at")
    .eq("id", token)
    .maybeSingle();

  if (error) {
    console.error("session-store: failed to look up session:", error.message);
    return false;
  }
  if (!data) return false;

  if (new Date(data.expires_at).getTime() < Date.now()) {
    // Expired - best-effort cleanup, but the verdict below doesn't depend on it.
    await client.from(TABLE).delete().eq("id", token);
    return false;
  }

  return true;
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const client = serverClient();
  if (!client) return;

  const { error } = await client.from(TABLE).delete().eq("id", token);
  if (error) {
    console.error("session-store: failed to destroy session:", error.message);
  }
}
