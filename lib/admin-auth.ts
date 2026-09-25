import { cookies } from "next/headers";
import { isValidSession } from "@/lib/session-store";

/**
 * Re-verifies the admin session INSIDE a server action / route handler.
 *
 * proxy.ts already gates every non-public path, but a Server Action is
 * reachable by a plain POST and is a security boundary in its own right:
 * anything that mutates data or exports PII re-checks the session itself
 * rather than trusting that the proxy matcher will always cover it
 * (defense in depth - a future matcher/public-path edit must not silently
 * expose these).
 */
export async function isAdminRequest(): Promise<boolean> {
  const token = (await cookies()).get("admin_auth")?.value ?? "";
  return isValidSession(token);
}

export const NOT_AUTHORIZED = "Not authorized - please log in again.";
