"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { browserClient } from "@/lib/supabase";
import { uploadWithProgress } from "@/lib/uploadWithProgress";
import { createUploadUrl, deleteCampaignClip, retryCampaignVideo } from "@/app/campaigns/actions";
import type { CampaignClip, CampaignVideo } from "@/lib/types";

// ── Upload zone ────────────────────────────────────────────────────────────
//
// Drag-and-drop or click-to-browse. The upload itself never touches this
// Next.js app's server: createUploadUrl only returns a signed Storage URL +
// token (JSON), and uploadWithProgress PUTs the raw file bytes straight to
// Supabase Storage from the browser - keeps a multi-GB source video off the
// Vercel serverless function entirely.

function UploadZone({
  campaignId,
  onUploaded,
}: {
  campaignId: string;
  onUploaded: (video: CampaignVideo) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setErr("");
    setUploading({ name: file.name, progress: 0 });

    try {
      const r = await createUploadUrl(campaignId, file.name);
      if (!r.ok || !r.signedUrl || !r.token || !r.videoId || !r.path) {
        throw new Error(r.error ?? "Failed to prepare upload.");
      }

      await uploadWithProgress("campaign-source-videos", r.path, r.token, file, (fraction) => {
        setUploading({ name: file.name, progress: fraction });
      });

      onUploaded({
        id: r.videoId,
        campaign_id: campaignId,
        original_filename: file.name,
        storage_path: r.path,
        status: "pending",
        claimed_by_hwid: null,
        claimed_at: null,
        heartbeat_at: null,
        progress_fraction: 0,
        progress_message: null,
        error_message: null,
        duration_seconds: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      });
      setUploading(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
      setUploading(null);
    }
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      onClick={() => !uploading && inputRef.current?.click()}
      className={`flex flex-col items-center justify-center gap-2 p-8 rounded-xl border-2 border-dashed
                  transition-colors ${uploading ? "cursor-default" : "cursor-pointer"}
                  ${dragOver ? "border-brand-blue bg-brand-blue/5" : "border-[#1e1e38] hover:border-[#3a3a60]"}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      {uploading ? (
        <div className="w-full max-w-sm flex flex-col gap-2">
          <p className="text-xs text-[#7070a0] truncate text-center">Uploading {uploading.name}…</p>
          <div className="h-2 w-full bg-[#08080f] rounded-full overflow-hidden border border-[#1e1e38]">
            <div
              className="h-full bg-brand-blue transition-[width]"
              style={{ width: `${Math.round(uploading.progress * 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-[#3a3a60] text-center">{Math.round(uploading.progress * 100)}%</p>
        </div>
      ) : (
        <>
          <span className="text-2xl">⬆</span>
          <p className="text-sm text-[#e8e8f0]">Drop a source video here, or click to browse</p>
          <p className="text-[11px] text-[#3a3a60]">Uploaded straight to storage - large files supported</p>
        </>
      )}
      {err && <p className="text-brand-orange text-xs">{err}</p>}
    </div>
  );
}

// ── Clip row (a produced clip inside a 'done' video) ──────────────────────────

function ClipRow({ clip }: { clip: CampaignClip }) {
  const [pending, startTransition] = useTransition();
  const [deleted, setDeleted] = useState(false);
  const [err, setErr] = useState("");

  if (deleted) return null;

  function handleDelete() {
    setErr("");
    setDeleted(true); // hide immediately — optimistic
    startTransition(async () => {
      const r = await deleteCampaignClip(clip.id);
      if (!r.ok) {
        setDeleted(false); // roll back
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-2 text-[11px] py-1">
      <span className="text-[#7070a0]">
        {clip.start_seconds.toFixed(1)}s–{clip.end_seconds.toFixed(1)}s ({clip.duration_seconds.toFixed(1)}s)
      </span>
      <div className="flex items-center gap-2">
        {err && <span className="text-brand-orange">{err}</span>}
        <button
          onClick={handleDelete}
          disabled={pending}
          className="text-[#7070a0] hover:text-brand-orange disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Video row (upload progress while in flight, clips once done) ────────────

const VIDEO_STATUS_STYLE: Record<CampaignVideo["status"], string> = {
  pending:   "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",
  claimed:   "bg-brand-blue/10 text-brand-blue border-brand-blue/30",
  analyzing: "bg-brand-blue/10 text-brand-blue border-brand-blue/30",
  done:      "bg-brand-mint/10 text-brand-mint border-brand-mint/30",
  failed:    "bg-brand-orange/10 text-brand-orange border-brand-orange/30",
};

function VideoRow({ video, clips }: { video: CampaignVideo; clips: CampaignClip[] }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function handleRetry() {
    setErr("");
    startTransition(async () => {
      const r = await retryCampaignVideo(video.id);
      if (!r.ok) setErr(r.error ?? "Failed");
    });
  }

  const inProgress = video.status === "pending" || video.status === "claimed" || video.status === "analyzing";

  return (
    <div className="flex flex-col gap-2 p-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-lg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-sm text-[#e8e8f0] truncate">{video.original_filename}</span>
          {video.duration_seconds != null && (
            <span className="text-[11px] text-[#3a3a60]">{Math.round(video.duration_seconds)}s source</span>
          )}
        </div>
        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${VIDEO_STATUS_STYLE[video.status]}`}>
          {video.status}
        </span>
      </div>

      {inProgress && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 w-full bg-[#08080f] rounded-full overflow-hidden border border-[#1e1e38]">
            <div
              className="h-full bg-brand-blue transition-[width]"
              style={{ width: `${Math.round(video.progress_fraction * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-[#7070a0]">
            {video.progress_message ?? "Waiting for a worker…"} ({Math.round(video.progress_fraction * 100)}%)
          </span>
        </div>
      )}

      {video.status === "failed" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-brand-orange truncate" title={video.error_message ?? undefined}>
            {video.error_message ?? "Failed"}
          </span>
          <button
            onClick={handleRetry}
            disabled={pending}
            className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium bg-[#141428] border border-[#1e1e38]
                       text-brand-blue hover:border-brand-blue transition-colors disabled:opacity-40"
          >
            Retry
          </button>
        </div>
      )}

      {video.status === "done" && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-left text-[11px] text-brand-blue hover:underline"
        >
          {expanded ? "Hide" : "Show"} {clips.length} clip{clips.length === 1 ? "" : "s"}
        </button>
      )}

      {expanded && video.status === "done" && (
        <div className="flex flex-col gap-0.5 pl-2 border-l border-[#1e1e38]">
          {clips.length === 0 && <p className="text-[11px] text-[#3a3a60]">No clips produced.</p>}
          {clips.map((c) => <ClipRow key={c.id} clip={c} />)}
        </div>
      )}

      {err && <span className="text-brand-orange text-[10px]">{err}</span>}
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

const VIDEO_SELECT = [
  "id", "campaign_id", "original_filename", "status",
  "progress_fraction", "progress_message", "error_message",
  "duration_seconds", "created_at", "completed_at",
] as const;

export default function CampaignVideosPanel({
  campaignId,
  videos: initialVideos,
  clips,
}: {
  campaignId: string;
  videos: CampaignVideo[];
  clips: CampaignClip[];
}) {
  const [videos, setVideos] = useState<CampaignVideo[]>(initialVideos);

  // Live progress/status (migration 029's anon Realtime grant on
  // campaign_videos - exactly these 10 columns; storage_path/claimed_by_hwid
  // etc. stay out). UPDATE covers a worker's heartbeat_analysis_job/
  // finish_analysis_job/fail_analysis_job progressing this row; INSERT
  // covers a second admin session uploading a video while this one is open
  // (mirrors SubmissionsTable.tsx's own INSERT-flavored subscription).
  useEffect(() => {
    const channel = browserClient
      .channel(`campaign-videos-${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "campaign_videos",
          filter: `campaign_id=eq.${campaignId}`,
          select: [...VIDEO_SELECT],
        },
        (payload) => {
          const updated = payload.new as Record<string, unknown>;
          setVideos((prev) =>
            prev.map((v) =>
              v.id === updated.id
                ? {
                    ...v,
                    status: (updated.status as CampaignVideo["status"] | undefined) ?? v.status,
                    progress_fraction: (updated.progress_fraction as number | null | undefined) ?? v.progress_fraction,
                    progress_message: (updated.progress_message as string | null | undefined) ?? v.progress_message,
                    error_message: (updated.error_message as string | null | undefined) ?? v.error_message,
                    duration_seconds: (updated.duration_seconds as number | null | undefined) ?? v.duration_seconds,
                    completed_at: (updated.completed_at as string | null | undefined) ?? v.completed_at,
                  }
                : v
            )
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "campaign_videos",
          filter: `campaign_id=eq.${campaignId}`,
          select: [...VIDEO_SELECT],
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          setVideos((prev) => {
            if (prev.some((v) => v.id === row.id)) return prev;
            const inserted: CampaignVideo = {
              id: row.id as string,
              campaign_id: row.campaign_id as string,
              original_filename: row.original_filename as string,
              storage_path: "", // not granted over Realtime - not displayed
              status: row.status as CampaignVideo["status"],
              claimed_by_hwid: null, // not granted over Realtime - not displayed
              claimed_at: null,
              heartbeat_at: null,
              progress_fraction: (row.progress_fraction as number | null) ?? 0,
              progress_message: (row.progress_message as string | null) ?? null,
              error_message: (row.error_message as string | null) ?? null,
              duration_seconds: (row.duration_seconds as number | null) ?? null,
              created_at: row.created_at as string,
              completed_at: (row.completed_at as string | null) ?? null,
            };
            return [inserted, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      browserClient.removeChannel(channel);
    };
  }, [campaignId]);

  const clipsByVideo = useMemo(() => {
    const map: Record<string, CampaignClip[]> = {};
    for (const c of clips) {
      (map[c.campaign_video_id] ??= []).push(c);
    }
    return map;
  }, [clips]);

  function handleUploaded(video: CampaignVideo) {
    setVideos((prev) => (prev.some((v) => v.id === video.id) ? prev : [video, ...prev]));
  }

  return (
    <div className="flex flex-col gap-4">
      <UploadZone campaignId={campaignId} onUploaded={handleUploaded} />
      <div className="flex flex-col gap-2">
        {videos.length === 0 && (
          <p className="text-[#3a3a60] text-sm px-2 py-6">No videos uploaded yet.</p>
        )}
        {videos.map((v) => (
          <VideoRow key={v.id} video={v} clips={clipsByVideo[v.id] ?? []} />
        ))}
      </div>
    </div>
  );
}
