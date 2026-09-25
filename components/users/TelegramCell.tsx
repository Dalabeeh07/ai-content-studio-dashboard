"use client";

import { useState, useTransition } from "react";
import { generateTelegramLinkCode, revokeTelegramLink, type LinkCodeResult } from "@/app/users/actions";
import { useCopyToClipboard } from "@/components/CopyCell";
import { BOT_USERNAME } from "@/lib/telegram/config";
import type { TelegramStatus, UserRow } from "@/lib/types";

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function until(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `in ${Math.max(1, h)}h` : `in ${Math.floor(h / 24)}d`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, copy] = useCopyToClipboard();
  return (
    <button
      onClick={() => copy(value)}
      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#1e1e38] text-[#e8e8f0] hover:border-brand-blue hover:text-brand-blue transition-colors"
    >
      {state === "copied" ? "✓ Copied" : state === "failed" ? "✗ Copy failed" : label}
    </button>
  );
}

// The code is shown exactly once: only its HMAC is stored server-side.
function CodeDialog({ user, result, onClose }: { user: UserRow; result: LinkCodeResult; onClose: () => void }) {
  const code = result.code ?? "";
  const who = user.email ?? `User #${user.hwid?.slice(0, 6) ?? "?"}`;
  const message =
    `مرحباً! لربط حسابك بالبوت: افتح @${BOT_USERNAME} في تيليجرام وأرسل:\n/link ${code}\n\n` +
    `(أو اضغط هذا الرابط: ${result.deepLink})\n\n` +
    `Hi! To link your account: open @${BOT_USERNAME} on Telegram and send:\n/link ${code}\n` +
    `(or tap: ${result.deepLink})\n\nExpires ${result.expiresAt ? new Date(result.expiresAt).toLocaleDateString("en-US") : "in 7 days"}.`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[#0f0f1c] border border-[#1e1e38] rounded-2xl p-6 shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">Telegram link code</h2>
        <p className="text-[#7070a0] text-sm mb-4">for <strong className="text-white">{who}</strong></p>
        <div className="text-center py-4 mb-3 rounded-xl bg-[#08080f] border border-[#1e1e38]">
          <span className="font-mono text-3xl font-bold tracking-[0.25em] text-brand-mint select-all">{code}</span>
          <p className="text-[#7070a0] text-xs mt-2">
            Single-use · expires {result.expiresAt ? new Date(result.expiresAt).toLocaleString("en-US") : "in 7 days"}
          </p>
        </div>
        <p className="text-brand-yellow text-xs mb-4">
          ⚠ Shown only once — the server keeps just a hash. If you lose it, generate a new one (that cancels this one).
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <CopyButton value={code} label="Copy code" />
          <CopyButton value={message} label="Copy message for the user (ع / EN)" />
        </div>
        <p className="text-[#3a3a60] text-[11px] break-all mb-4">{result.deepLink}</p>
        <div className="flex justify-end">
          <button onClick={onClose} className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-brand-blue hover:bg-[#6aadff] transition-colors">
            I&apos;ve copied it — close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TelegramCell({ user, status }: { user: UserRow; status: TelegramStatus | undefined }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LinkCodeResult | null>(null);
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");

  const btn = "px-2 py-0.5 rounded text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  function generate() {
    setErr(""); setNote("");
    startTransition(async () => {
      const r = await generateTelegramLinkCode(user.id);
      if (!r.ok) { setErr(r.error ?? "Failed"); return; }
      setResult(r);
    });
  }

  function revoke() {
    setErr(""); setNote(""); setConfirming(false);
    if (!user.hwid) return;
    startTransition(async () => {
      const r = await revokeTelegramLink(user.hwid as string);
      if (!r.ok) { setErr(r.error ?? "Failed"); return; }
      setNote(r.note ?? "Revoked.");
    });
  }

  const linked = status?.linked === true;
  const codePending = !linked && !!status?.pendingCodeExpiresAt;

  return (
    <div className="flex flex-col gap-1 min-w-[150px]">
      {linked ? (
        <span className="text-xs text-brand-mint" title={status?.linkedAt ?? ""}>
          ✈ Linked{status?.username ? ` · @${status.username}` : ` · id ${status?.telegramUserId}`}
          <span className="text-[#3a3a60]"> · {ago(status?.linkedAt ?? null)}</span>
        </span>
      ) : codePending ? (
        <span className="text-xs text-brand-yellow">Code pending · expires {until(status?.pendingCodeExpiresAt ?? null)}</span>
      ) : (
        <span className="text-xs text-[#3a3a60]">Not linked</span>
      )}
      {linked && status?.pendingCodeExpiresAt && (
        <span className="text-[10px] text-brand-yellow">new code pending · {until(status.pendingCodeExpiresAt)}</span>
      )}

      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={generate}
          disabled={pending || !user.hwid}
          title={!user.hwid ? "This user has no device ID" : linked ? "Generate a code to move the link to another Telegram account" : "Generate a one-time code"}
          className={`${btn} bg-[#141428] border-[#1e1e38] text-brand-blue hover:border-brand-blue hover:bg-[#0e1e38]`}
        >
          {linked || codePending ? "New code" : "Generate code"}
        </button>
        {(linked || codePending) && !confirming && (
          <button onClick={() => setConfirming(true)} disabled={pending}
            className={`${btn} bg-[#141428] border-[#1e1e38] text-brand-orange hover:border-brand-orange hover:bg-[#2a1010]`}>
            Revoke
          </button>
        )}
        {confirming && (
          <>
            <button onClick={revoke} disabled={pending} className={`${btn} bg-brand-orange border-transparent text-white`}>Confirm revoke</button>
            <button onClick={() => setConfirming(false)} className={`${btn} border-[#1e1e38] text-[#7070a0]`}>Cancel</button>
          </>
        )}
      </div>
      {err && <span className="text-brand-orange text-[10px]">{err}</span>}
      {note && <span className="text-brand-mint text-[10px]">{note}</span>}

      {result?.ok && (
        <CodeDialog user={user} result={result} onClose={() => setResult(null)} />
      )}
    </div>
  );
}
