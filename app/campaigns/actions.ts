"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase";
import type { CampaignContentType, CampaignStatus } from "@/lib/types";

// These five literal values are wired verbatim into the desktop app's
// existing Gemini-prompt-selection logic (services/smart_clipper.py and
// services/hook_service.py) - do not add/rename without updating that
// side too. "entertainment"/"finance" added in migration 040 (Whop's own
// Content Rewards category tags - podcast-specific and music campaigns
// were deliberately excluded, per the founder).
const VALID_CONTENT_TYPES: readonly CampaignContentType[] =
    ["gaming", "podcast", "vlog", "entertainment", "finance"];
const VALID_STATUSES: readonly CampaignStatus[] = ["active", "paused", "deleted"];

// ── Create campaign ──────────────────────────────────────────────────────────

export async function createCampaign(
  name: string,
  contentType: string,
  termsText: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  if (!VALID_CONTENT_TYPES.includes(contentType as CampaignContentType)) {
    return { ok: false, error: "Invalid content type." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data, error } = await db
    .from("campaigns")
    .insert({ name: trimmed, content_type: contentType, terms_text: termsText.trim() })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true, id: data?.id };
}

// ── Edit an existing campaign's content type / terms ─────────────────────────

export async function updateCampaignDetails(
  campaignId: string,
  contentType: string,
  termsText: string
): Promise<{ ok: boolean; error?: string }> {
  if (!VALID_CONTENT_TYPES.includes(contentType as CampaignContentType)) {
    return { ok: false, error: "Invalid content type." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaigns")
    .update({ content_type: contentType, terms_text: termsText.trim() })
    .eq("id", campaignId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true };
}

// ── Pause / resume / soft-delete a campaign ───────────────────────────────────
//
// 'deleted' is just another status value (migration 028) - the row is never
// actually removed, so a user's past export history can still resolve the
// campaign name afterward. Browsing/opening (list_active_campaigns/
// open_campaign RPCs) only ever considers status = 'active'.

export async function updateCampaignStatus(
  campaignId: string,
  status: string
): Promise<{ ok: boolean; error?: string }> {
  if (!VALID_STATUSES.includes(status as CampaignStatus)) {
    return { ok: false, error: "Invalid status." };
  }
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaigns")
    .update({ status })
    .eq("id", campaignId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true };
}

// ── Add hooks to a campaign's pool ───────────────────────────────────────────
//
// One hook text per line - matches how the founder will most naturally
// paste in a pre-written batch of hook lines at once (rule 1: "add hook
// text to a specific campaign's pool").

export async function addHooks(
  campaignId: string,
  rawText: string
): Promise<{ ok: boolean; added?: number; error?: string }> {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: "Enter at least one hook (one per line)." };

  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaign_hooks")
    .insert(lines.map((text) => ({ campaign_id: campaignId, text })));

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true, added: lines.length };
}

// ── Delete an unclaimed hook ─────────────────────────────────────────────────
//
// Only ever removes a row that is still 'available' - a claimed hook is
// permanent history (who got what), and a reserved one is mid-flight for a
// real export attempt, so deleting either from under the desktop app would
// be a real, harmful surprise for whoever is currently exporting with it.

export async function deleteHook(hookId: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaign_hooks")
    .delete()
    .eq("id", hookId)
    .eq("status", "available");

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true };
}

// ── Video upload: mint a signed Storage upload URL ────────────────────────────
//
// Bytes never pass through this server action (or any Vercel serverless
// function) - only this JSON round trip does. The browser uploads the raw
// file straight to Supabase Storage with the returned signedUrl/token (see
// lib/uploadWithProgress.ts), which is what keeps a multi-GB source video
// off the free-plan request-body-size limit entirely.
//
// The campaign_videos row is inserted FIRST (status='pending'), with an
// id generated here rather than left to the table's default, purely so the
// storage_path can embed that exact id before the signed URL is minted -
// path is `{campaignId}/{videoId}/{filename}` inside campaign-source-videos,
// matching what claim_analysis_job hands the worker pool.

export async function createUploadUrl(
  campaignId: string,
  filename: string
): Promise<{
  ok: boolean;
  videoId?: string;
  signedUrl?: string;
  token?: string;
  path?: string;
  error?: string;
}> {
  const cleanName = filename.trim();
  if (!cleanName) return { ok: false, error: "Filename is required." };
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const videoId = randomUUID();
  const path = `${campaignId}/${videoId}/${cleanName}`;

  const { error: insertErr } = await db.from("campaign_videos").insert({
    id: videoId,
    campaign_id: campaignId,
    original_filename: cleanName,
    storage_path: path,
    status: "pending",
  });
  if (insertErr) return { ok: false, error: insertErr.message };

  const { data: signed, error: signErr } = await db.storage
    .from("campaign-source-videos")
    .createSignedUploadUrl(path);
  if (signErr || !signed) {
    // Row already exists but no usable URL was minted for it - remove it so
    // it doesn't sit forever as a phantom 'pending' job nothing will ever
    // claim or let the founder retry (retryCampaignVideo only handles
    // 'failed', not this).
    await db.from("campaign_videos").delete().eq("id", videoId);
    return { ok: false, error: signErr?.message ?? "Failed to create upload URL." };
  }

  revalidatePath("/campaigns");
  return { ok: true, videoId, signedUrl: signed.signedUrl, token: signed.token, path };
}

// ── Delete a produced clip (hard delete) ──────────────────────────────────────
//
// Immediate effect even if the clip has already been exported by users -
// campaign_exports.campaign_clip_id is ON DELETE SET NULL, so their export
// history survives with a null clip reference, just like the spec asks.
// Storage object is removed first to reclaim space; a 404 there (object
// already gone) doesn't block the DB row from being removed too.

export async function deleteCampaignClip(clipId: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { data: clip, error: readErr } = await db
    .from("campaign_clips")
    .select("storage_path")
    .eq("id", clipId)
    .single();
  if (readErr) return { ok: false, error: readErr.message };

  if (clip?.storage_path) {
    const { error: storageErr } = await db.storage
      .from("campaign-clips")
      .remove([clip.storage_path]);
    if (storageErr && !/not.?found/i.test(storageErr.message)) {
      return { ok: false, error: storageErr.message };
    }
  }

  const { error: deleteErr } = await db.from("campaign_clips").delete().eq("id", clipId);
  if (deleteErr) return { ok: false, error: deleteErr.message };

  revalidatePath("/campaigns");
  return { ok: true };
}

// ── Retry a failed analysis job ───────────────────────────────────────────────
//
// Resets a 'failed' campaign_videos row back to 'pending' and clears every
// claim field, so claim_analysis_job's worker-pool query picks it up again
// as a fresh job. Only ever transitions FROM 'failed' - never interrupts a
// job that's currently claimed/analyzing.

export async function retryCampaignVideo(videoId: string): Promise<{ ok: boolean; error?: string }> {
  const db = serverClient();
  if (!db) return { ok: false, error: "Server not configured." };

  const { error } = await db
    .from("campaign_videos")
    .update({
      status: "pending",
      claimed_by_hwid: null,
      claimed_at: null,
      heartbeat_at: null,
      progress_fraction: 0,
      progress_message: null,
      error_message: null,
    })
    .eq("id", videoId)
    .eq("status", "failed");

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaigns");
  return { ok: true };
}
