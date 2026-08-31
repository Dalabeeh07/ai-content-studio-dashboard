"use client";

import { useState, useTransition } from "react";
import { sendNotification } from "@/app/notifications/actions";

interface UserOption {
  hardware_id: string;
  label: string;
}

interface Props {
  users: UserOption[];
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#7070a0] mb-1.5">
      {children}
    </label>
  );
}

function FieldError({ msg }: { msg: string }) {
  return <p className="text-brand-orange text-xs mt-1">{msg}</p>;
}

function CharCount({ value, max }: { value: string; max: number }) {
  const remaining = max - value.length;
  const warn = remaining < max * 0.15;
  return (
    <span className={`text-xs ${warn ? "text-brand-orange" : "text-[#3a3a60]"}`}>
      {remaining} left
    </span>
  );
}

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium border
        ${ok
          ? "bg-brand-mint/10 border-brand-mint/30 text-brand-mint"
          : "bg-brand-orange/10 border-brand-orange/30 text-brand-orange"
        }`}
    >
      <span>{ok ? "✓" : "⚠"}</span>
      {msg}
    </div>
  );
}

export default function ComposeForm({ users }: Props) {
  const [pending, startTransition] = useTransition();

  const [message, setMessage] = useState("");
  const [target, setTarget]   = useState<"all" | "specific">("all");
  const [hwid, setHwid]       = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast]   = useState<{ ok: boolean; msg: string } | null>(null);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!message.trim())               e.message = "Message is required.";
    if (target === "specific" && !hwid) e.hwid    = "Select a user.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const fd = new FormData();
    fd.set("message",     message.trim());
    fd.set("target",      target);
    fd.set("hardware_id", hwid);

    setToast(null);

    startTransition(async () => {
      const result = await sendNotification(fd);
      if (result.ok) {
        const count = result.recipientCount ?? 0;
        setToast({ ok: true, msg: `Sent to ${count} ${count === 1 ? "user" : "users"}.` });
        setMessage(""); setTarget("all"); setHwid(""); setErrors({});
      } else {
        setToast({ ok: false, msg: result.error ?? "Unknown error." });
      }
    });
  }

  const inputCls =
    "w-full bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm text-[#e8e8f0]" +
    " placeholder-[#3a3a60] focus:outline-none focus:border-[#4a9eff] transition-colors";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Message */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label>Message</Label>
          <CharCount value={message} max={500} />
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder="Notification message…"
          className={`${inputCls} resize-none`}
        />
        {errors.message && <FieldError msg={errors.message} />}
      </div>

      {/* Send to */}
      <div>
        <Label>Send to</Label>
        <div className="flex gap-3">
          {(["all", "specific"] as const).map((t) => (
            <label
              key={t}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer transition-colors text-sm
                ${target === t
                  ? "border-brand-blue bg-brand-blue/5 text-brand-blue font-semibold"
                  : "border-[#1e1e38] text-[#7070a0] hover:border-[#3a3a60]"
                }`}
            >
              <input
                type="radio"
                value={t}
                checked={target === t}
                onChange={() => { setTarget(t); setHwid(""); }}
                className="accent-brand-blue"
              />
              {t === "all" ? "All Users" : "Specific User"}
            </label>
          ))}
        </div>

        {target === "specific" && (
          <div className="mt-3">
            <select
              value={hwid}
              onChange={(e) => setHwid(e.target.value)}
              className={inputCls}
            >
              <option value="">Select a user…</option>
              {users.map((u) => (
                <option key={u.hardware_id} value={u.hardware_id}>
                  {u.label}
                </option>
              ))}
            </select>
            {errors.hwid && <FieldError msg={errors.hwid} />}
          </div>
        )}
      </div>

      {/* Toast feedback */}
      {toast && <Toast ok={toast.ok} msg={toast.msg} />}

      {/* Submit */}
      <button
        type="submit"
        disabled={pending}
        className="w-full py-2.5 rounded-xl text-sm font-bold text-white
                   bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60]
                   transition-colors"
      >
        {pending ? "Sending…" : "Send Notification"}
      </button>
    </form>
  );
}
