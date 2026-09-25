import { serverClient } from "@/lib/supabase";
import type { Lang } from "./types";
import type { Platform } from "./url";

// The bot's ENTIRE data layer is a handful of tg_* service-role functions
// (supabase/migrations/041_telegram_link_intake.sql). `RpcClient` is the
// only seam: production uses Supabase (`supabaseRpc`), tests use an adapter
// that runs the SAME functions in real Postgres (PGlite) - so the handler is
// exercised against real SQL semantics, not a hand-written fake.

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export class StoreError extends Error {
  constructor(public fn: string, message: string, public code?: string) {
    super(`${fn}: ${message}`);
    this.name = "StoreError";
  }
}

export function supabaseRpc(): RpcClient {
  const db = serverClient();
  if (!db) {
    return {
      async rpc(fn) {
        throw new StoreError(fn, "SUPABASE_SERVICE_KEY / NEXT_PUBLIC_SUPABASE_URL not configured");
      },
    };
  }
  return {
    async rpc(fn, args) {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw new StoreError(fn, error.message, error.code);
      return data;
    },
  };
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface UserContext {
  known: boolean;
  language: Lang | null;
  username: string | null;
  linked: boolean;
  hwid: string | null;
  userId: string | null;
  linkedAt: string | null;
}

export type RedeemResult =
  | { ok: true; hwid: string; userId: string | null; replacedPrevious: boolean }
  | { ok: false; reason: "invalid_code" | "already_linked" | "conflict"; detail?: string };

export interface SubmitItem {
  video_url: string;
  canonical_url: string;
  platform: Platform;
  username: string;
  opaque: boolean;
}

export type SubmitOutcome = "accepted" | "duplicate" | "duplicate_other" | "error";

export type SubmitResult =
  | {
      ok: true;
      results: { canonicalUrl: string; outcome: SubmitOutcome; id: string | null }[];
      todayCount: number;
      licenseActive: boolean;
    }
  | { ok: false; reason: "not_linked" };

export interface CampaignOption {
  campaignId: string;
  name: string;
  lastExportAt: string;
}

export interface MyLink {
  platform: string;
  videoUrl: string;
  status: string;
  submittedAt: string;
  whopSubmittedAt: string | null;
  source: string;
}

export interface RateResult {
  granted: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface CampaignChoiceResult {
  ok: boolean;
  campaignName?: string;
  updated?: number;
}

// ── Store ───────────────────────────────────────────────────────────────────

const isLang = (x: unknown): x is Lang => x === "ar" || x === "en";

export class Store {
  constructor(private c: RpcClient) {}

  async claimUpdate(updateId: number, staleSeconds: number, maxAttempts: number): Promise<"new" | "retry" | "duplicate"> {
    const r = await this.c.rpc("tg_claim_update", { p_update_id: updateId, p_stale_seconds: staleSeconds, p_max_attempts: maxAttempts });
    if (r === "new" || r === "retry" || r === "duplicate") return r;
    throw new StoreError("tg_claim_update", `unexpected result ${JSON.stringify(r)}`);
  }

  async finishUpdate(updateId: number, status: "done" | "failed"): Promise<void> {
    await this.c.rpc("tg_finish_update", { p_update_id: updateId, p_status: status });
  }

  async rateConsume(key: string, windowSeconds: number, limit: number, want: number): Promise<RateResult> {
    const rows = (await this.c.rpc("tg_rate_consume", { p_key: key, p_window_seconds: windowSeconds, p_limit: limit, p_want: want })) as
      { granted: number; remaining: number; retry_after_seconds: number }[] | null;
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) throw new StoreError("tg_rate_consume", "no row returned");
    return { granted: r.granted, remaining: r.remaining, retryAfterSeconds: r.retry_after_seconds };
  }

  async rateRefund(key: string, n: number): Promise<void> {
    if (n > 0) await this.c.rpc("tg_rate_refund", { p_key: key, p_n: n });
  }

  async getContext(telegramUserId: number, username: string | null): Promise<UserContext> {
    const r = (await this.c.rpc("tg_get_context", { p_telegram_user_id: telegramUserId, p_username: username })) as Record<string, unknown> | null;
    if (!r || typeof r !== "object") throw new StoreError("tg_get_context", "no result");
    return {
      known: r.known === true,
      language: isLang(r.language) ? r.language : null,
      username: typeof r.username === "string" ? r.username : null,
      linked: r.linked === true,
      hwid: typeof r.hwid === "string" ? r.hwid : null,
      userId: typeof r.user_id === "string" ? r.user_id : null,
      linkedAt: typeof r.linked_at === "string" ? r.linked_at : null,
    };
  }

  async setLanguage(telegramUserId: number, username: string | null, lang: Lang): Promise<void> {
    await this.c.rpc("tg_set_language", { p_telegram_user_id: telegramUserId, p_username: username, p_language: lang });
  }

  async redeemLinkCode(codeHash: string, telegramUserId: number, username: string | null, lang: Lang): Promise<RedeemResult> {
    const r = (await this.c.rpc("tg_redeem_link_code", {
      p_code_hash: codeHash, p_telegram_user_id: telegramUserId, p_username: username, p_language: lang,
    })) as Record<string, unknown> | null;
    if (!r || typeof r !== "object") throw new StoreError("tg_redeem_link_code", "no result");
    if (r.ok === true) {
      return { ok: true, hwid: String(r.hwid), userId: typeof r.user_id === "string" ? r.user_id : null, replacedPrevious: r.replaced_previous === true };
    }
    const reason = r.reason === "already_linked" || r.reason === "conflict" ? r.reason : "invalid_code";
    return { ok: false, reason, detail: typeof r.detail === "string" ? r.detail : undefined };
  }

  async submitLinks(telegramUserId: number, updateId: number, campaignId: string | null, items: SubmitItem[]): Promise<SubmitResult> {
    const r = (await this.c.rpc("tg_submit_links", {
      p_telegram_user_id: telegramUserId, p_update_id: updateId, p_campaign_id: campaignId, p_items: items,
    })) as Record<string, unknown> | null;
    if (!r || typeof r !== "object") throw new StoreError("tg_submit_links", "no result");
    if (r.ok !== true) return { ok: false, reason: "not_linked" };
    const results = (Array.isArray(r.results) ? r.results : []) as { canonical_url: string; outcome: SubmitOutcome; id: string | null }[];
    return {
      ok: true,
      results: results.map((x) => ({ canonicalUrl: x.canonical_url, outcome: x.outcome, id: x.id ?? null })),
      todayCount: typeof r.today_count === "number" ? r.today_count : 0,
      licenseActive: r.license_active === true,
    };
  }

  async recentCampaigns(hwid: string, sinceIso: string, limit: number): Promise<CampaignOption[]> {
    const rows = (await this.c.rpc("tg_recent_campaigns", { p_hwid: hwid, p_since: sinceIso, p_limit: limit })) as
      { campaign_id: string; name: string; last_export_at: string }[] | null;
    return (rows ?? []).map((x) => ({ campaignId: x.campaign_id, name: x.name, lastExportAt: x.last_export_at }));
  }

  async createChoice(kind: "campaign" | "unlink", telegramUserId: number, chatId: number, token: string, payload: unknown, ttlSeconds: number): Promise<void> {
    await this.c.rpc("tg_create_choice", {
      p_token: token, p_kind: kind, p_telegram_user_id: telegramUserId, p_chat_id: chatId, p_payload: payload, p_ttl_seconds: ttlSeconds,
    });
  }

  async applyCampaignChoice(token: string, telegramUserId: number, chatId: number, index: number): Promise<CampaignChoiceResult> {
    const r = (await this.c.rpc("tg_apply_campaign_choice", {
      p_token: token, p_telegram_user_id: telegramUserId, p_chat_id: chatId, p_index: index,
    })) as Record<string, unknown> | null;
    if (!r || r.ok !== true) return { ok: false };
    return { ok: true, campaignName: String(r.campaign_name ?? ""), updated: Number(r.updated ?? 0) };
  }

  async consumeChoice(token: string, kind: "campaign" | "unlink", telegramUserId: number, chatId: number): Promise<boolean> {
    const r = (await this.c.rpc("tg_consume_choice", {
      p_token: token, p_kind: kind, p_telegram_user_id: telegramUserId, p_chat_id: chatId,
    })) as { ok?: boolean } | null;
    return r?.ok === true;
  }

  async unlink(telegramUserId: number): Promise<number> {
    return Number(await this.c.rpc("tg_unlink", { p_telegram_user_id: telegramUserId })) || 0;
  }

  async myLinks(hwid: string, limit: number): Promise<MyLink[]> {
    const rows = (await this.c.rpc("tg_my_links", { p_hwid: hwid, p_limit: limit })) as
      { platform: string; video_url: string; status: string; submitted_at: string; whop_submitted_at: string | null; source: string }[] | null;
    return (rows ?? []).map((x) => ({
      platform: x.platform, videoUrl: x.video_url, status: x.status, submittedAt: x.submitted_at,
      whopSubmittedAt: x.whop_submitted_at ?? null, source: x.source,
    }));
  }

  async todayCount(telegramUserId: number): Promise<number> {
    return Number(await this.c.rpc("tg_today_count", { p_telegram_user_id: telegramUserId })) || 0;
  }
}
