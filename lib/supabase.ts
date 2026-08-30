import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder";

// Browser-safe client (anon key)
export const browserClient = createClient(supabaseUrl, supabaseAnonKey);

// Server-only client (service key — bypasses RLS)
export function serverClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!url || !serviceKey) {
    throw new Error("Supabase env vars not configured");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
