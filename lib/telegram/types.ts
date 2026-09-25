import type { TgEntity } from "./url";

export type Lang = "ar" | "en";

// Only the fields of the Telegram Bot API we actually read. Everything is
// optional/unknown-tolerant because the webhook body is untrusted input and
// is validated (`parseUpdate`) before use.
export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/**
 * Validate the untrusted parsed body and return a narrowed update, or null
 * if it is not something we handle. Deliberately strict: edited_message,
 * channel_post, group/supergroup/channel chats, bot senders, and messages
 * with neither text nor caption are all rejected HERE, before any DB access,
 * so ignored traffic costs zero writes.
 */
export function parseUpdate(body: unknown): TgUpdate | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const updateId = b.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;

  const isUser = (u: unknown): u is TgUser =>
    !!u && typeof u === "object" &&
    typeof (u as TgUser).id === "number" && Number.isSafeInteger((u as TgUser).id) && (u as TgUser).id > 0 &&
    (u as TgUser).is_bot !== true;

  const cleanUser = (u: TgUser): TgUser => ({
    id: u.id,
    is_bot: false,
    username: typeof u.username === "string" ? u.username.slice(0, 64) : undefined,
    language_code: typeof u.language_code === "string" ? u.language_code.slice(0, 16) : undefined,
  });

  const asMessage = (m: unknown): TgMessage | null => {
    if (!m || typeof m !== "object") return null;
    const mm = m as Record<string, unknown>;
    const chat = mm.chat as TgChat | undefined;
    if (!chat || typeof chat !== "object" || chat.type !== "private" ||
        typeof chat.id !== "number" || !Number.isSafeInteger(chat.id)) return null;
    if (typeof mm.message_id !== "number" || !Number.isSafeInteger(mm.message_id)) return null;
    return {
      message_id: mm.message_id,
      chat: { id: chat.id, type: "private" },
      from: isUser(mm.from) ? cleanUser(mm.from) : undefined,
      text: typeof mm.text === "string" ? mm.text : undefined,
      caption: typeof mm.caption === "string" ? mm.caption : undefined,
      entities: Array.isArray(mm.entities) ? (mm.entities as TgEntity[]) : undefined,
      caption_entities: Array.isArray(mm.caption_entities) ? (mm.caption_entities as TgEntity[]) : undefined,
    };
  };

  if (b.message !== undefined) {
    const m = asMessage(b.message);
    if (!m || !m.from) return null;
    if (m.from.id !== m.chat.id) return null; // private chat id always equals the user id
    if (m.text === undefined && m.caption === undefined) return null;
    return { update_id: updateId, message: m };
  }

  if (b.callback_query !== undefined) {
    const cq = b.callback_query as Record<string, unknown> | null;
    if (!cq || typeof cq !== "object") return null;
    if (typeof cq.id !== "string" || cq.id.length === 0 || cq.id.length > 128) return null;
    if (!isUser(cq.from)) return null;
    const m = cq.message === undefined ? null : asMessage(cq.message);
    return {
      update_id: updateId,
      callback_query: {
        id: cq.id,
        from: cleanUser(cq.from),
        message: m ?? undefined,
        data: typeof cq.data === "string" ? cq.data.slice(0, 64) : undefined,
      },
    };
  }

  return null; // edited_message, channel_post, inline_query, my_chat_member, ...
}
