"use client";

import { useState } from "react";
import {
  DEFAULT_FILTERS, hasActiveFilters,
  type SubmissionFilters,
} from "@/lib/submissions/filters";
import { PAGE_SIZE_OPTIONS } from "@/lib/telegram/config";
import type { CampaignOption } from "@/lib/submissions/query";

const SELECT =
  "bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-2.5 py-1.5 text-xs text-[#e8e8f0] " +
  "focus:outline-none focus:border-[#4a9eff] transition-colors";
const INPUT = SELECT + " placeholder-[#3a3a60]";

// Filters live in the URL (the server re-validates them on every request), so
// a filtered view is shareable, survives refresh, and the back button works.
// Dropdowns apply immediately; the text/date inputs apply on submit.
export default function SubmissionsFilters({
  filters, campaigns, size, onApply, onSize, busy,
}: {
  filters: SubmissionFilters;
  campaigns: CampaignOption[];
  size: number;
  onApply: (next: SubmissionFilters) => void;
  onSize: (size: number) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(filters);
  // Re-sync when navigation (chips, back button) changes the URL filters.
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) { setSeen(filters); setDraft(filters); }

  const set = <K extends keyof SubmissionFilters>(k: K, v: SubmissionFilters[K], apply = false) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    if (apply) onApply(next);
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onApply(draft); }}
      className="flex flex-wrap items-end gap-2.5 p-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-xl"
    >
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Source
        <select className={SELECT} value={draft.source} onChange={(e) => set("source", e.target.value as SubmissionFilters["source"], true)}>
          <option value="all">All</option>
          <option value="telegram">Telegram</option>
          <option value="app">Desktop app</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Whop
        <select className={SELECT} value={draft.whop} onChange={(e) => set("whop", e.target.value as SubmissionFilters["whop"], true)}>
          <option value="all">All</option>
          <option value="pending">Not submitted yet</option>
          <option value="submitted">Submitted</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Campaign
        <select className={SELECT + " max-w-[180px]"} value={draft.campaign} onChange={(e) => set("campaign", e.target.value, true)}>
          <option value="all">All</option>
          <option value="none">— No campaign —</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.status !== "active" ? ` (${c.status})` : ""}</option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Platform
        <select className={SELECT} value={draft.platform} onChange={(e) => set("platform", e.target.value as SubmissionFilters["platform"], true)}>
          <option value="all">All</option>
          <option value="tiktok">TikTok</option>
          <option value="instagram">Instagram</option>
          <option value="youtube">YouTube</option>
          <option value="x">X</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Status
        <select className={SELECT} value={draft.status} onChange={(e) => set("status", e.target.value as SubmissionFilters["status"], true)}>
          <option value="all">All</option>
          <option value="pending_review">Pending review</option>
          <option value="verified">Verified</option>
          <option value="disputed">Disputed</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Flags
        <select className={SELECT} value={draft.flag} onChange={(e) => set("flag", e.target.value as SubmissionFilters["flag"], true)}>
          <option value="all">Any</option>
          <option value="any">Suspicious (dup / license)</option>
          <option value="dup">Duplicate by other user</option>
          <option value="license">License inactive</option>
          <option value="short">Short link (unresolved)</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        From (UTC)
        <input type="date" className={INPUT} value={draft.from} onChange={(e) => set("from", e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        To (UTC)
        <input type="date" className={INPUT} value={draft.to} onChange={(e) => set("to", e.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0] flex-1 min-w-[180px]">
        Search
        <input
          type="search"
          className={INPUT}
          placeholder="link, handle, email, @telegram, device id"
          value={draft.q}
          maxLength={80}
          onChange={(e) => set("q", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#7070a0]">
        Per page
        <select className={SELECT} value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <button
        type="submit"
        disabled={busy}
        className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60] transition-colors"
      >
        Apply
      </button>
      {(hasActiveFilters(filters) || hasActiveFilters(draft)) && (
        <button
          type="button"
          onClick={() => { setDraft(DEFAULT_FILTERS); onApply(DEFAULT_FILTERS); }}
          className="px-3 py-1.5 rounded-lg text-xs text-[#7070a0] border border-[#1e1e38] hover:border-[#3a3a60] hover:text-white transition-colors"
        >
          Clear
        </button>
      )}
      {filters.user && (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] bg-brand-blue/10 border border-brand-blue/30 text-brand-blue">
          one user only
          <button type="button" onClick={() => onApply({ ...draft, user: "" })} className="hover:text-white" title="Show all users">✕</button>
        </span>
      )}
    </form>
  );
}
