"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  createCampaign, addHooks, deleteHook,
  updateCampaignStatus, updateCampaignDetails,
} from "@/app/campaigns/actions";
import { browserClient } from "@/lib/supabase";
import { CopyCell } from "@/components/CopyCell";
import CampaignVideosPanel from "@/components/campaigns/CampaignVideosPanel";
import CampaignCompliancePanel from "@/components/campaigns/CampaignCompliancePanel";
import type {
  Campaign, CampaignClip, CampaignCompliance, CampaignContentType,
  CampaignHook, CampaignHookStatusRow, CampaignStatus, CampaignVideo,
} from "@/lib/types";

// Below this many unclaimed hooks, a campaign gets a visible low-pool
// warning (rule 1: "get an alert/warning when a campaign's pool is running
// low... don't let it silently hit zero with no warning").
const LOW_POOL_THRESHOLD = 3;

type HookCounts = { total: number; available: number; claimed: number };

const CONTENT_TYPES: { value: CampaignContentType; label: string }[] = [
  { value: "gaming", label: "Gaming" },
  { value: "podcast", label: "Podcast" },
  { value: "vlog", label: "Vlog" },
];

// ── Create campaign ──────────────────────────────────────────────────────────

function CreateCampaignForm() {
  const [name, setName] = useState("");
  const [contentType, setContentType] = useState<CampaignContentType>("gaming");
  const [termsText, setTermsText] = useState("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function handleCreate() {
    if (!name.trim()) return;
    setErr("");
    startTransition(async () => {
      const r = await createCampaign(name, contentType, termsText);
      if (r.ok) {
        setName("");
        setTermsText("");
        setContentType("gaming");
      } else {
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 p-4 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">
        New campaign
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Gaming Q1 Hooks"
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] placeholder-[#3a3a60] focus:outline-none focus:border-brand-blue"
      />
      <select
        value={contentType}
        onChange={(e) => setContentType(e.target.value as CampaignContentType)}
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] focus:outline-none focus:border-brand-blue"
      >
        {CONTENT_TYPES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <textarea
        value={termsText}
        onChange={(e) => setTermsText(e.target.value)}
        rows={3}
        placeholder="Campaign-specific terms &amp; conditions (re-shown to a user every time they open this campaign)…"
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] placeholder-[#3a3a60] resize-y focus:outline-none focus:border-brand-blue"
      />
      <button
        onClick={handleCreate}
        disabled={pending || !name.trim()}
        className="px-4 py-2 rounded-lg text-sm font-semibold text-white
                   bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60] transition-colors"
      >
        Create
      </button>
      {err && <p className="text-brand-orange text-xs">{err}</p>}
    </div>
  );
}

// ── Campaign list (left column) ──────────────────────────────────────────────

function CampaignList({
  campaigns,
  activeId,
  hookCounts,
}: {
  campaigns: Campaign[];
  activeId: string | null;
  hookCounts: Record<string, HookCounts>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {campaigns.length === 0 && (
        <p className="text-[#3a3a60] text-sm px-2 py-4">No campaigns yet.</p>
      )}
      {campaigns.map((c) => {
        const counts = hookCounts[c.id] ?? { total: c.total_hooks, available: c.available_hooks, claimed: c.claimed_hooks };
        const isLow = counts.available <= LOW_POOL_THRESHOLD;
        const active = c.id === activeId;
        return (
          <Link
            key={c.id}
            href={`/campaigns?campaign=${c.id}`}
            className={`flex flex-col gap-1 px-3 py-2.5 rounded-lg border transition-colors
                        ${active
                          ? "bg-brand-blue/10 border-brand-blue/40"
                          : "bg-[#0f0f1c] border-[#1e1e38] hover:border-[#3a3a60]"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[#e8e8f0] truncate">{c.name}</span>
              <div className="flex items-center gap-1 shrink-0">
                {c.status !== "active" && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full capitalize
                                    bg-[#3a3a60]/30 text-[#7070a0] border border-[#3a3a60]">
                    {c.status}
                  </span>
                )}
                {isLow && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full
                                    bg-brand-orange/15 text-brand-orange border border-brand-orange/30">
                    LOW
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-3 text-[11px] text-[#7070a0]">
              <span>{counts.available} available</span>
              <span>{counts.claimed} claimed</span>
              <span className="capitalize">{c.content_type}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ── Campaign detail header: status badge, edit toggle, pause/resume/delete ──

const CAMPAIGN_STATUS_STYLE: Record<CampaignStatus, string> = {
  active:  "bg-brand-mint/10 text-brand-mint border-brand-mint/30",
  paused:  "bg-brand-yellow/10 text-brand-yellow border-brand-yellow/30",
  deleted: "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",
};

function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border capitalize ${CAMPAIGN_STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

function EditCampaignForm({
  campaign,
  onSaved,
  onOptimisticPatch,
}: {
  campaign: Campaign;
  onSaved: () => void;
  onOptimisticPatch: (id: string, patch: Partial<Pick<Campaign, "content_type" | "terms_text">>) => void;
}) {
  const [contentType, setContentType] = useState<CampaignContentType>(campaign.content_type);
  const [termsText, setTermsText] = useState(campaign.terms_text);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function handleSave() {
    setErr("");
    const prevContentType = campaign.content_type;
    const prevTermsText = campaign.terms_text;
    onOptimisticPatch(campaign.id, { content_type: contentType, terms_text: termsText });
    startTransition(async () => {
      const r = await updateCampaignDetails(campaign.id, contentType, termsText);
      if (r.ok) {
        onSaved();
      } else {
        onOptimisticPatch(campaign.id, { content_type: prevContentType, terms_text: prevTermsText });
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 p-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-lg">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Content type</label>
      <select
        value={contentType}
        onChange={(e) => setContentType(e.target.value as CampaignContentType)}
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] focus:outline-none focus:border-brand-blue"
      >
        {CONTENT_TYPES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Terms &amp; conditions</label>
      <textarea
        value={termsText}
        onChange={(e) => setTermsText(e.target.value)}
        rows={5}
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] placeholder-[#3a3a60] resize-y focus:outline-none focus:border-brand-blue"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={pending}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white
                     bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60] transition-colors"
        >
          Save
        </button>
        {err && <span className="text-brand-orange text-xs">{err}</span>}
      </div>
    </div>
  );
}

function CampaignDetailHeader({
  campaign,
  onOptimisticPatch,
}: {
  campaign: Campaign;
  onOptimisticPatch: (id: string, patch: Partial<Pick<Campaign, "status" | "content_type" | "terms_text">>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function setStatus(next: CampaignStatus) {
    const prev = campaign.status;
    setErr("");
    setConfirmingDelete(false);
    onOptimisticPatch(campaign.id, { status: next });
    startTransition(async () => {
      const r = await updateCampaignStatus(campaign.id, next);
      if (!r.ok) {
        onOptimisticPatch(campaign.id, { status: prev });
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-bold text-[#e8e8f0]">{campaign.name}</h2>
          <CampaignStatusBadge status={campaign.status} />
          <span className="text-[11px] px-2 py-0.5 rounded-full border border-[#1e1e38] text-[#7070a0] capitalize">
            {campaign.content_type}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setEditing((v) => !v)}
            className="text-xs text-[#7070a0] hover:text-brand-blue transition-colors"
          >
            {editing ? "Cancel edit" : "Edit"}
          </button>
          {campaign.status !== "deleted" && (
            campaign.status === "active" ? (
              <button
                onClick={() => setStatus("paused")}
                disabled={pending}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#141428] border border-[#1e1e38]
                           text-brand-yellow hover:border-brand-yellow transition-colors disabled:opacity-40"
              >
                Pause
              </button>
            ) : (
              <button
                onClick={() => setStatus("active")}
                disabled={pending}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#141428] border border-[#1e1e38]
                           text-brand-mint hover:border-brand-mint transition-colors disabled:opacity-40"
              >
                Resume
              </button>
            )
          )}
          {campaign.status !== "deleted" && !confirmingDelete && (
            <button
              onClick={() => setConfirmingDelete(true)}
              disabled={pending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#141428] border border-[#1e1e38]
                         text-brand-orange hover:border-brand-orange transition-colors disabled:opacity-40"
            >
              Delete
            </button>
          )}
          {confirmingDelete && (
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-brand-orange">Really delete this campaign?</span>
              <button
                onClick={() => setStatus("deleted")}
                disabled={pending}
                className="px-2.5 py-1 rounded-md text-xs font-semibold text-white
                           bg-brand-orange hover:bg-[#ff8860] transition-colors"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="px-2.5 py-1 rounded-md text-xs text-[#7070a0]
                           border border-[#1e1e38] hover:text-white transition-colors"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>
      {err && <p className="text-brand-orange text-xs">{err}</p>}
      {editing && (
        <EditCampaignForm
          campaign={campaign}
          onSaved={() => setEditing(false)}
          onOptimisticPatch={onOptimisticPatch}
        />
      )}
    </div>
  );
}

// ── Add hooks form ────────────────────────────────────────────────────────────

function AddHooksForm({ campaignId }: { campaignId: string }) {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function handleAdd() {
    setErr("");
    setMsg("");
    startTransition(async () => {
      const r = await addHooks(campaignId, text);
      if (r.ok) {
        setText("");
        setMsg(`Added ${r.added} hook${r.added === 1 ? "" : "s"}.`);
      } else {
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 p-4 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">
        Add hooks (one per line)
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"You won't believe this clutch!\nWait for the ending...\nThis changed everything"}
        className="bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                   text-[#e8e8f0] placeholder-[#3a3a60] resize-y font-mono
                   focus:outline-none focus:border-brand-blue"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleAdd}
          disabled={pending || !text.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white
                     bg-brand-mint/90 hover:bg-brand-mint disabled:bg-[#3a3a60] transition-colors"
        >
          Add to pool
        </button>
        {msg && <span className="text-brand-mint text-xs">{msg}</span>}
        {err && <span className="text-brand-orange text-xs">{err}</span>}
      </div>
    </div>
  );
}

// ── Hook pool table ───────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  available: "bg-brand-mint/10 text-brand-mint border-brand-mint/30",
  reserved:  "bg-brand-orange/10 text-brand-orange border-brand-orange/30",
  claimed:   "bg-[#3a3a60]/30 text-[#7070a0] border-[#3a3a60]",
};

function HookRow({ hook }: { hook: CampaignHook }) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");
  const [deleted, setDeleted] = useState(false);

  if (deleted) return null;

  function handleDelete() {
    setErr("");
    setDeleted(true); // hide immediately — optimistic
    startTransition(async () => {
      const r = await deleteHook(hook.id);
      if (!r.ok) {
        setDeleted(false); // roll back
        setErr(r.error ?? "Failed");
      }
    });
  }

  return (
    <tr className="hover:bg-[#0f0f1c] transition-colors">
      <td className="px-4 py-2.5 text-sm text-[#e8e8f0]">{hook.text}</td>
      <td className="px-4 py-2.5">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${STATUS_STYLE[hook.status]}`}>
          {hook.status}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs text-[#7070a0]">
        {hook.claimed_by_email ?? (hook.claimed_by_hwid ? <CopyCell value={hook.claimed_by_hwid} display={hook.claimed_by_hwid.slice(0, 10) + "…"} /> : "—")}
      </td>
      <td className="px-4 py-2.5 text-right">
        {hook.status === "available" && (
          <button
            onClick={handleDelete}
            disabled={pending}
            className="text-xs text-[#7070a0] hover:text-brand-orange disabled:opacity-40"
          >
            Delete
          </button>
        )}
        {err && <span className="block text-brand-orange text-[10px]">{err}</span>}
      </td>
    </tr>
  );
}

function HookPool({ campaign, hooks, counts }: { campaign: Campaign; hooks: CampaignHook[]; counts: HookCounts }) {
  const isLow = counts.available <= LOW_POOL_THRESHOLD;
  return (
    <div className="flex flex-col gap-4">
      {isLow && (
        <div className="flex justify-end">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full
                            bg-brand-orange/15 text-brand-orange border border-brand-orange/30">
            ⚠ Only {counts.available} hook{counts.available === 1 ? "" : "s"} left - add more soon
          </span>
        </div>
      )}

      <AddHooksForm campaignId={campaign.id} />

      <div className="overflow-x-auto rounded-xl border border-[#1e1e38]">
        <table className="w-full border-collapse">
          <thead className="bg-[#0f0f1c] border-b border-[#1e1e38]">
            <tr>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Hook text</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Status</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[#7070a0]">Claimed by</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="bg-[#08080f] divide-y divide-[#1e1e38]">
            {hooks.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-[#7070a0] text-sm">
                  No hooks in this campaign&apos;s pool yet.
                </td>
              </tr>
            )}
            {hooks.map((h) => <HookRow key={h.id} hook={h} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

type Tab = "hooks" | "videos" | "compliance";

export default function CampaignsPanel({
  campaigns: initialCampaigns,
  activeId,
  hooks,
  hookStatuses: initialHookStatuses,
  videos,
  clips,
  compliance,
}: {
  campaigns: Campaign[];
  activeId: string | null;
  hooks: CampaignHook[];
  hookStatuses: CampaignHookStatusRow[];
  videos: CampaignVideo[];
  clips: CampaignClip[];
  compliance: CampaignCompliance;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);
  const [lastSeenInitialCampaigns, setLastSeenInitialCampaigns] = useState(initialCampaigns);
  if (initialCampaigns !== lastSeenInitialCampaigns) {
    setLastSeenInitialCampaigns(initialCampaigns);
    setCampaigns(initialCampaigns);
  }

  const [hookStatuses, setHookStatuses] = useState<CampaignHookStatusRow[]>(initialHookStatuses);
  const [lastSeenInitialHookStatuses, setLastSeenInitialHookStatuses] = useState(initialHookStatuses);
  if (initialHookStatuses !== lastSeenInitialHookStatuses) {
    setLastSeenInitialHookStatuses(initialHookStatuses);
    setHookStatuses(initialHookStatuses);
  }

  const [tab, setTab] = useState<Tab>("hooks");

  function patchCampaign(id: string, patch: Partial<Pick<Campaign, "status" | "content_type" | "terms_text">>) {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  // Live campaign status/content_type/terms_text changes from any admin
  // session (migration 029's anon Realtime grant on campaigns - exactly
  // id, name, content_type, terms_text, status, created_at).
  useEffect(() => {
    const channel = browserClient
      .channel("campaigns-live")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "campaigns",
          select: ["id", "name", "content_type", "terms_text", "status", "created_at"],
        },
        (payload) => {
          const updated = payload.new as Record<string, unknown>;
          setCampaigns((prev) =>
            prev.map((c) =>
              c.id === updated.id
                ? {
                    ...c,
                    name: (updated.name as string | undefined) ?? c.name,
                    content_type: (updated.content_type as Campaign["content_type"] | undefined) ?? c.content_type,
                    terms_text: (updated.terms_text as string | undefined) ?? c.terms_text,
                    status: (updated.status as Campaign["status"] | undefined) ?? c.status,
                  }
                : c
            )
          );
        }
      )
      .subscribe();

    return () => {
      browserClient.removeChannel(channel);
    };
  }, []);

  // Live hook-pool counts (migration 029's anon Realtime grant on
  // campaign_hooks - id, campaign_id, status, created_at; text stays
  // server-only-readable). Tracked row-by-row rather than as a bare
  // aggregate: Realtime's `old` payload only carries the primary key unless
  // the table has REPLICA IDENTITY FULL, so a single UPDATE event alone
  // can't tell us which bucket (available/claimed) a hook moved FROM -
  // keeping every row's current status client-side and recomputing the
  // aggregate on each change sidesteps that.
  useEffect(() => {
    const channel = browserClient
      .channel("campaign-hooks-counts")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "campaign_hooks",
          select: ["id", "campaign_id", "status", "created_at"],
        },
        (payload) => {
          const updated = payload.new as Record<string, unknown>;
          setHookStatuses((prev) =>
            prev.map((h) =>
              h.id === updated.id
                ? { ...h, status: (updated.status as CampaignHookStatusRow["status"] | undefined) ?? h.status }
                : h
            )
          );
        }
      )
      .subscribe();

    return () => {
      browserClient.removeChannel(channel);
    };
  }, []);

  const hookCounts = useMemo(() => {
    const map: Record<string, HookCounts> = {};
    for (const h of hookStatuses) {
      const entry = (map[h.campaign_id] ??= { total: 0, available: 0, claimed: 0 });
      entry.total += 1;
      if (h.status === "available") entry.available += 1;
      if (h.status === "claimed") entry.claimed += 1;
    }
    return map;
  }, [hookStatuses]);

  const active = campaigns.find((c) => c.id === activeId) ?? null;
  const activeCounts: HookCounts = active
    ? hookCounts[active.id] ?? { total: active.total_hooks, available: active.available_hooks, claimed: active.claimed_hooks }
    : { total: 0, available: 0, claimed: 0 };

  return (
    <div className="grid grid-cols-[280px_1fr] gap-6 items-start">
      <div className="flex flex-col gap-4">
        <CreateCampaignForm />
        <CampaignList campaigns={campaigns} activeId={activeId} hookCounts={hookCounts} />
      </div>

      <div className="flex flex-col gap-4">
        {active ? (
          <>
            <CampaignDetailHeader campaign={active} onOptimisticPatch={patchCampaign} />

            <div className="flex gap-1 border-b border-[#1e1e38]">
              {([
                { key: "hooks", label: "Hooks" },
                { key: "videos", label: "Videos & Clips" },
                { key: "compliance", label: "Compliance" },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide transition-colors border-b-2 -mb-px
                              ${tab === t.key
                                ? "border-brand-blue text-brand-blue"
                                : "border-transparent text-[#7070a0] hover:text-[#e8e8f0]"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "hooks" && <HookPool campaign={active} hooks={hooks} counts={activeCounts} />}
            {tab === "videos" && (
              <CampaignVideosPanel key={active.id} campaignId={active.id} videos={videos} clips={clips} />
            )}
            {tab === "compliance" && (
              <CampaignCompliancePanel key={active.id} compliance={compliance} />
            )}
          </>
        ) : (
          <p className="text-[#3a3a60] text-sm px-2 py-8">
            Create a campaign to start adding hooks.
          </p>
        )}
      </div>
    </div>
  );
}
