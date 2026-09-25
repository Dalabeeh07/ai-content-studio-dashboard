// Real-Postgres (PGlite/WASM) harness for migration 041.
//
// It rebuilds ONLY the parts of the live schema the migration depends on,
// then applies the REAL migration files (009 for video_submissions +
// submit_video_link, 024 for the Realtime grant, 041 = this work), so a
// syntax error, wrong grant, or broken RPC is caught here - not in the
// founder's SQL Editor. It also reproduces the hostile default privileges
// the live project has (Supabase's grant-everything defaults, then the
// 029/039 revocations) so the "service_role only" claim is tested against
// the worst case rather than a friendly empty database.
//
// Limits (stated honestly): PGlite is single-connection, so it proves SQL
// LOGIC, not concurrent-transaction behaviour. Concurrency (parallel code
// redemption, parallel duplicate updates) is tested against the real
// Supabase project in tests/integration.
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(process.cwd(), "..", "supabase", "migrations");

export function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
}

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  -- Supabase's stock defaults (everything to everyone)...
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  -- ...then migration 029's table revocation and migration 039's function revocation.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

  CREATE PUBLICATION supabase_realtime;

  -- Stubs shaped like the LIVE tables (columns confirmed via the service-key OpenAPI probe).
  CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT, hwid TEXT, hardware_id TEXT, license_key TEXT,
    social_accounts JSONB, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE public.licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL, hwid TEXT, hardware_id TEXT, status TEXT,
    expires_at TIMESTAMPTZ, plan_type TEXT NOT NULL DEFAULT 'free'
  );
  CREATE TABLE public.campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE public.campaign_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
    hwid TEXT NOT NULL,
    exported_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export type Db = PGlite;

/** Build the pre-041 world (009 + 022's video_submissions revoke + 024). */
export async function makePre041(): Promise<Db> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(readMigration("009_video_submissions.sql"));
  await db.exec("REVOKE ALL ON public.video_submissions FROM anon;"); // migration 022's relevant statement
  await db.exec(readMigration("024_video_submissions_realtime.sql"));
  return db;
}

export async function make041(): Promise<Db> {
  const db = await makePre041();
  await db.exec(readMigration("041_telegram_link_intake.sql"));
  return db;
}

/** Run a statement AS a role, then restore superuser (mimics PostgREST's role switch). */
export async function asRole<T = unknown>(db: Db, role: "anon" | "authenticated" | "service_role", sql: string, params: unknown[] = []) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec("RESET ROLE");
  }
}

export async function expectDenied(db: Db, role: "anon" | "authenticated", sql: string, params: unknown[] = []): Promise<string> {
  try {
    await asRole(db, role, sql, params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/permission denied|row-level security|must be owner/i.test(msg)) return msg;
    throw new Error(`expected a permission error for ${role}: ${sql}\n  got: ${msg}`);
  }
  throw new Error(`expected ${role} to be DENIED but the statement succeeded: ${sql}`);
}
