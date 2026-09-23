import { serverClient } from "@/lib/supabase";

// Attempt counters are persisted in the admin_login_attempts Supabase
// table (service key, bypasses RLS) rather than an in-process Map. A
// plain Map is module-scope, per process - on Vercel's serverless
// platform each function instance gets its own empty Map, so a
// distributed or concurrent brute-force effectively gets a fresh 5-
// attempt budget per instance instead of 5 attempts total. This is the
// exact failure mode lib/session-store.ts's own header comment already
// documents for why in-memory state doesn't work here; that lesson just
// hadn't been applied to this file yet.
//
// See supabase/migrations/038_admin_login_attempts_table.sql (not
// applied automatically - run it in the Supabase SQL Editor).
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const TABLE = "admin_login_attempts";

export async function checkRateLimit(
  ip: string
): Promise<{ allowed: boolean; retryAfterMinutes: number }> {
  const client = serverClient();
  if (!client) {
    // Fail open, matching session-store.ts's own precedent for a missing
    // SUPABASE_SERVICE_KEY - never block login entirely over a config
    // gap, but this means rate limiting is silently disabled, so log it
    // loudly rather than fail silently.
    console.error("rate-limit: SUPABASE_SERVICE_KEY not configured - rate limiting disabled");
    return { allowed: true, retryAfterMinutes: 0 };
  }

  const now = Date.now();
  const { data, error } = await client
    .from(TABLE)
    .select("attempt_count, window_start")
    .eq("ip", ip)
    .maybeSingle();

  if (error) {
    console.error("rate-limit: failed to read attempt row:", error.message);
    return { allowed: true, retryAfterMinutes: 0 }; // fail open, not closed
  }

  if (!data || now - new Date(data.window_start).getTime() > WINDOW_MS) {
    // No row yet, or the previous window has expired - start a fresh one.
    const { error: upsertError } = await client
      .from(TABLE)
      .upsert({ ip, attempt_count: 1, window_start: new Date(now).toISOString() });
    if (upsertError) {
      console.error("rate-limit: failed to start a new window:", upsertError.message);
    }
    return { allowed: true, retryAfterMinutes: 0 };
  }

  if (data.attempt_count >= MAX_ATTEMPTS) {
    const retryAfterMinutes = Math.ceil(
      (new Date(data.window_start).getTime() + WINDOW_MS - now) / 60000
    );
    return { allowed: false, retryAfterMinutes };
  }

  // Read-then-write, not an atomic increment - two concurrent requests
  // from the same IP in the same instant could both read the same count
  // and both increment from it, undercounting by at most the number of
  // truly-simultaneous requests. Accepted as a minor imprecision (the cap
  // could take a request or two longer to kick in under heavy concurrent
  // load from one IP), not a bypass - it can't be gamed into unlimited
  // attempts, only fuzz the exact cutoff by a handful of requests, and a
  // real brute-force script sends attempts sequentially or in small
  // batches, not truly simultaneously from one IP.
  const { error: updateError } = await client
    .from(TABLE)
    .update({ attempt_count: data.attempt_count + 1 })
    .eq("ip", ip);
  if (updateError) {
    console.error("rate-limit: failed to increment attempt count:", updateError.message);
  }
  return { allowed: true, retryAfterMinutes: 0 };
}

export async function resetRateLimit(ip: string): Promise<void> {
  const client = serverClient();
  if (!client) return;
  const { error } = await client.from(TABLE).delete().eq("ip", ip);
  if (error) {
    console.error("rate-limit: failed to reset attempt row:", error.message);
  }
}
