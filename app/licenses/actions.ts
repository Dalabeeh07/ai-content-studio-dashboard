"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";

// ── Key generator ─────────────────────────────────────────────────────────────

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 (ambiguous)

function randomSegment(len = 4): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return s;
}

function generateKey(): string {
  return `${randomSegment()}-${randomSegment()}-${randomSegment()}-${randomSegment()}`;
}

// ── Generate licenses ─────────────────────────────────────────────────────────

export async function generateLicenses(formData: FormData): Promise<{
  ok: boolean;
  keys?: string[];
  error?: string;
}> {
  const creditsLimit = Math.max(1, Number(formData.get("credits_limit")) || 50);
  const userLabel    = (formData.get("label") as string).trim() || null;
  const expiresRaw   = (formData.get("expires") as string) || null;
  const quantity     = Math.min(10, Math.max(1, Number(formData.get("quantity")) || 1));

  const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;

  const rows = Array.from({ length: quantity }, () => ({
    key:           generateKey(),
    credits_limit: creditsLimit,
    label:         userLabel,
    expires_at:    expiresAt,
    status:        "active" as const,
  }));

  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db.from("licenses").insert(rows);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/licenses");
  return { ok: true, keys: rows.map((r) => r.key) };
}

// ── Revoke license ────────────────────────────────────────────────────────────

export async function revokeLicense(licenseKey: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("licenses")
    .update({ status: "revoked" })
    .eq("key", licenseKey);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/licenses");
  return { ok: true };
}

// ── Bulk revoke ───────────────────────────────────────────────────────────────

export async function bulkRevoke(keys: string[]): Promise<{ ok: boolean; error?: string }> {
  if (keys.length === 0) return { ok: true };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("licenses")
    .update({ status: "revoked" })
    .in("key", keys);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/licenses");
  return { ok: true };
}

// ── Unbind device ─────────────────────────────────────────────────────────────

export async function unbindDevice(licenseKey: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("licenses")
    .update({ hardware_id: null, activated_at: null })
    .eq("key", licenseKey);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/licenses");
  return { ok: true };
}

// ── Edit credits ──────────────────────────────────────────────────────────────

export async function updateCredits(licenseKey: string, credits: number): Promise<{ ok: boolean; error?: string }> {
  if (credits < 1 || credits > 10_000) return { ok: false, error: "Credits must be 1–10,000." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };
  const { error } = await db
    .from("licenses")
    .update({ credits_limit: credits })
    .eq("key", licenseKey);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/licenses");
  return { ok: true };
}
