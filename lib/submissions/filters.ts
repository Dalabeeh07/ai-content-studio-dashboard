// Pure (no I/O) filter model for the Submissions page, the export route and
// the bulk server actions. ONE parser is used everywhere so the list, the
// count, the export and "select all matching" can never disagree about what
// a filter means - and because every entry point re-parses with
// sanitizeFilters(), a hand-crafted request can only ever carry a valid,
// narrowly-typed filter (never raw text that reaches a query string).

import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/lib/telegram/config";

export const SOURCE_VALUES = ["all", "app", "telegram"] as const;
export const STATUS_VALUES = ["all", "pending_review", "verified", "disputed"] as const;
export const PLATFORM_VALUES = ["all", "tiktok", "instagram", "youtube", "x"] as const;
export const WHOP_VALUES = ["all", "pending", "submitted"] as const;
export const FLAG_VALUES = ["all", "dup", "license", "short", "any"] as const;

export interface SubmissionFilters {
  source: (typeof SOURCE_VALUES)[number];
  status: (typeof STATUS_VALUES)[number];
  /** "all" | "none" (no campaign) | campaign uuid */
  campaign: string;
  platform: (typeof PLATFORM_VALUES)[number];
  /** all | pending (not yet hand-submitted to Whop) | submitted */
  whop: (typeof WHOP_VALUES)[number];
  /** dup = duplicate_of_other_user, license = license_inactive, short = short_link, any = dup OR license ("suspicious") */
  flag: (typeof FLAG_VALUES)[number];
  /** inclusive UTC dates, YYYY-MM-DD or "" */
  from: string;
  to: string;
  /** free text over url / handle / hwid / email / telegram username */
  q: string;
  /** exact users.id (uuid) or "" */
  user: string;
}

export const DEFAULT_FILTERS: SubmissionFilters = {
  source: "all", status: "all", campaign: "all", platform: "all", whop: "all",
  flag: "all", from: "", to: "", q: "", user: "",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function pick<T extends readonly string[]>(allowed: T, v: unknown, fallback: T[number]): T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

export function validDate(v: unknown): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return "";
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? "" : v;
}

/** Free text is reduced to letters/digits and a few URL/email-safe symbols:
 * it is later embedded in a PostgREST `or=(...)` expression, where commas,
 * parentheses, `*` and `%` are syntax - they simply cannot survive here. */
export function cleanQuery(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[^\p{L}\p{N}@._:\-/ ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Accepts anything (URLSearchParams entries, a client-sent object, ...). */
export function sanitizeFilters(input: Record<string, unknown> | null | undefined): SubmissionFilters {
  const i = input ?? {};
  const first = (k: string): unknown => (Array.isArray(i[k]) ? (i[k] as unknown[])[0] : i[k]);
  const campaign = first("campaign");
  return {
    source: pick(SOURCE_VALUES, first("source"), "all"),
    status: pick(STATUS_VALUES, first("status"), "all"),
    campaign: campaign === "none" ? "none" : isUuid(campaign) ? campaign.toLowerCase() : "all",
    platform: pick(PLATFORM_VALUES, first("platform"), "all"),
    whop: pick(WHOP_VALUES, first("whop"), "all"),
    flag: pick(FLAG_VALUES, first("flag"), "all"),
    from: validDate(first("from")),
    to: validDate(first("to")),
    q: cleanQuery(first("q")),
    user: isUuid(first("user")) ? (first("user") as string).toLowerCase() : "",
  };
}

export function hasActiveFilters(f: SubmissionFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof SubmissionFilters)[]).some((k) => f[k] !== DEFAULT_FILTERS[k]);
}

/** Only non-default values, so shared URLs stay short and readable. */
export function filtersToParams(f: SubmissionFilters): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULT_FILTERS) as (keyof SubmissionFilters)[]) {
    if (f[k] !== DEFAULT_FILTERS[k]) p.set(k, f[k]);
  }
  return p;
}

export interface PageParams { page: number; size: number }

export function parsePageParams(sp: Record<string, unknown> | null | undefined): PageParams {
  const raw = (k: string) => { const v = sp?.[k]; return Array.isArray(v) ? v[0] : v; };
  const size = Number(raw("size"));
  const page = Number(raw("page"));
  return {
    size: (PAGE_SIZE_OPTIONS as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/** A bulk operation targets either an explicit id list or "everything matching
 * these filters as of `asOf`". The `asOf` cutoff + `expectedCount` exist so a
 * row that arrived AFTER the founder looked at the list can never be swept
 * into a "mark as submitted" he never saw or copied. */
export type BulkScope =
  | { mode: "ids"; ids: string[] }
  | { mode: "filter"; filters: SubmissionFilters; asOf: string; expectedCount: number };

export function validIso(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
