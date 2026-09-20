"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { createCampaign, addHooks, deleteHook } from "@/app/campaigns/actions";
import { CopyCell } from "@/components/CopyCell";
import type { Campaign, CampaignHook } from "@/lib/types";

// Below this many unclaimed hooks, a campaign gets a visible low-pool
// warning (rule 1: "get an alert/warning when a campaign's pool is running
// low... don't let it silently hit zero with no warning").
const LOW_POOL_THRESHOLD = 3;

// ── Create campaign ──────────────────────────────────────────────────────────

function CreateCampaignForm() {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  function handleCreate() {
    if (!name.trim()) return;
    setErr("");
    startTransition(async () => {
      const r = await createCampaign(name);
      if (r.ok) {
        setName("");
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
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Gaming Q1 Hooks"
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          className="flex-1 bg-[#08080f] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm
                     text-[#e8e8f0] placeholder-[#3a3a60] focus:outline-none focus:border-brand-blue"
        />
        <button
          onClick={handleCreate}
          disabled={pending || !name.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white
                     bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60] transition-colors"
        >
          Create
        </button>
      </div>
      {err && <p className="text-brand-orange text-xs">{err}</p>}
    </div>
  );
}

// ── Campaign list (left column) ──────────────────────────────────────────────

function CampaignList({ campaigns, activeId }: { campaigns: Campaign[]; activeId: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      {campaigns.length === 0 && (
        <p className="text-[#3a3a60] text-sm px-2 py-4">No campaigns yet.</p>
      )}
      {campaigns.map((c) => {
        const isLow = c.available_hooks <= LOW_POOL_THRESHOLD;
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
              <span className="text-sm font-medium text-[#e8e8f0]">{c.name}</span>
              {isLow && (
                <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full
                                  bg-brand-orange/15 text-brand-orange border border-brand-orange/30">
                  LOW
                </span>
              )}
            </div>
            <div className="flex gap-3 text-[11px] text-[#7070a0]">
              <span>{c.available_hooks} available</span>
              <span>{c.claimed_hooks} claimed</span>
              <span>{c.assigned_user_count} assigned</span>
            </div>
          </Link>
        );
      })}
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

  function handleDelete() {
    setErr("");
    startTransition(async () => {
      const r = await deleteHook(hook.id);
      if (!r.ok) setErr(r.error ?? "Failed");
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

function HookPool({ campaign, hooks }: { campaign: Campaign; hooks: CampaignHook[] }) {
  const isLow = campaign.available_hooks <= LOW_POOL_THRESHOLD;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[#e8e8f0]">{campaign.name}</h2>
        {isLow && (
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full
                            bg-brand-orange/15 text-brand-orange border border-brand-orange/30">
            ⚠ Only {campaign.available_hooks} hook{campaign.available_hooks === 1 ? "" : "s"} left - add more soon
          </span>
        )}
      </div>

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

export default function CampaignsPanel({
  campaigns,
  activeId,
  hooks,
}: {
  campaigns: Campaign[];
  activeId: string | null;
  hooks: CampaignHook[];
}) {
  const active = campaigns.find((c) => c.id === activeId) ?? null;

  return (
    <div className="grid grid-cols-[280px_1fr] gap-6 items-start">
      <div className="flex flex-col gap-4">
        <CreateCampaignForm />
        <CampaignList campaigns={campaigns} activeId={activeId} />
      </div>

      <div>
        {active ? (
          <HookPool campaign={active} hooks={hooks} />
        ) : (
          <p className="text-[#3a3a60] text-sm px-2 py-8">
            Create a campaign to start adding hooks.
          </p>
        )}
      </div>
    </div>
  );
}
