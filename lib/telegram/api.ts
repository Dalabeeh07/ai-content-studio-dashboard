import { BOT_API_TIMEOUT_MS } from "./config";

// Minimal Telegram Bot API client. Server-side only: the token is read from
// the environment at call time and is NEVER logged, returned, or included in
// an error message (the request URL contains it, so raw fetch errors must not
// be printed - only the error class name and Telegram's own `description`).
//
// Every method resolves to a boolean and NEVER throws: a failed reply must
// not fail the webhook or lose the link that was already saved.

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

export interface BotApi {
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<boolean>;
}

export interface BotApiConfig {
  token: string;
  /** Overridable ONLY so tests can point at a local fake Telegram. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createBotApi(cfg: BotApiConfig): BotApi {
  const base = (cfg.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? fetch;
  let warnedNoToken = false;

  async function call(method: string, payload: Record<string, unknown>): Promise<boolean> {
    if (!cfg.token) {
      if (!warnedNoToken) {
        warnedNoToken = true;
        console.error("telegram: TELEGRAM_BOT_TOKEN not configured - replies are disabled");
      }
      return false;
    }
    try {
      const res = await doFetch(`${base}/bot${cfg.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? BOT_API_TIMEOUT_MS),
      });
      if (res.ok) return true;
      let description = "";
      try {
        const j = (await res.json()) as { description?: string };
        description = typeof j.description === "string" ? j.description.slice(0, 200) : "";
      } catch { /* non-JSON error body */ }
      console.error(`telegram: ${method} failed: HTTP ${res.status} ${description}`);
      return false;
    } catch (err) {
      // err.message / err.cause can embed the request URL (and so the token).
      console.error(`telegram: ${method} request error: ${err instanceof Error ? err.name : "unknown"}`);
      return false;
    }
  }

  return {
    sendMessage: (chatId, text, keyboard) =>
      call("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    answerCallbackQuery: (id, text) =>
      call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) }),
    editMessageText: (chatId, messageId, text) =>
      call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4000),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      }),
  };
}

export function botApiFromEnv(): BotApi {
  return createBotApi({
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    baseUrl: process.env.TELEGRAM_API_BASE || undefined,
  });
}
