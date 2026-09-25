import { NextRequest } from "next/server";
import { botApiFromEnv } from "@/lib/telegram/api";
import { hashLinkCode } from "@/lib/telegram/codes";
import { Store, supabaseRpc } from "@/lib/telegram/store";
import { processWebhook } from "@/lib/telegram/webhook";

// Telegram -> dashboard webhook for @PlovikaLinksBot. All logic lives in
// lib/telegram/webhook.ts (see its header for the status-code contract).
//
// Public path: listed in proxy.ts so the admin session gate does not 307 it
// to /login. Its only authentication is the X-Telegram-Bot-Api-Secret-Token
// header, checked in constant time before anything else happens.
//
// setWebhook (scripts/set-telegram-webhook.mjs) registers allowed_updates
// ["message", "callback_query"], so edited_message is never even delivered;
// if one arrives anyway it is dropped in parseUpdate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  return processWebhook(req, {
    secret,
    store: new Store(supabaseRpc()),
    bot: botApiFromEnv(),
    hashCode: (code) => hashLinkCode(code, secret),
  });
}
