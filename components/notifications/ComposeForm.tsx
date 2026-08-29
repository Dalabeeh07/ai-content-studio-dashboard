"use client";

import { useRef, useState, useTransition } from "react";
import { sendNotification } from "@/app/notifications/actions";

interface UserOption {
  hardware_id: string;
  label: string;
}

interface Props {
  users: UserOption[];
}

const TYPE_OPTIONS = [
  { value: "message",  label: "📢 Message",        desc: "General message to users" },
  { value: "update",   label: "🔄 Update Alert",   desc: "New app version or changelog" },
  { value: "campaign", label: "💰 New Campaign",   desc: "New earning opportunity" },
];

// ── Inline field components ───────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#7070a0] mb-1.5">
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        "w-full bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm text-[#e8e8f0]" +
        " placeholder-[#3a3a60] focus:outline-none focus:border-[#4a9eff] transition-colors" +
        (props.className ? ` ${props.className}` : "")
      }
    />
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

// ── Toast ─────────────────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export default function ComposeForm({ users }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  // Field state
  const [type, setType]       = useState("message");
  const [title, setTitle]     = useState("");
  const [body, setBody]       = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [target, setTarget]   = useState<"all" | "specific">("all");
  const [hwid, setHwid]       = useState("");
  const [expires, setExpires] = useState("");

  // Validation + feedback
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast]   = useState<{ ok: boolean; msg: string } | null>(null);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!title.trim())               e.title = "Title is required.";
    if (!body.trim())                e.body  = "Body is required.";
    if (target === "specific" && !hwid) e.hwid = "Select a user.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const fd = new FormData();
    fd.set("type",        type);
    fd.set("title",       title.trim());
    fd.set("body",        body.trim());
    fd.set("action_url",  actionUrl.trim());
    fd.set("target",      target);
    fd.set("hardware_id", hwid);
    fd.set("expires",     expires);

    setToast(null);

    startTransition(async () => {
      const result = await sendNotification(fd);
      if (result.ok) {
        const count = result.recipientCount ?? 0;
        setToast({
          ok:  true,
          msg: `Sent to ${count} ${count === 1 ? "user" : "users"}.`,
        });
        // Reset form
        setTitle(""); setBody(""); setActionUrl(""); setTarget("all");
        setHwid(""); setExpires(""); setErrors({});
      } else {
        setToast({ ok: false, msg: result.error ?? "Unknown error." });
      }
    });
  }

  const inputCls =
    "w-full bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm text-[#e8e8f0]" +
    " placeholder-[#3a3a60] focus:outline-none focus:border-[#4a9eff] transition-colors";

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Type */}
      <div>
        <Label>Type</Label>
        <div className="flex flex-col gap-2">
          {TYPE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
                ${type === o.value
                  ? "border-brand-blue bg-brand-blue/5"
                  : "border-[#1e1e38] hover:border-[#3a3a60]"
                }`}
            >
              <input
                type="radio"
                name="type_radio"
                value={o.value}
                checked={type === o.value}
                onChange={() => setType(o.value)}
                className="mt-0.5 accent-brand-blue"
              />
              <div>
                <p className="text-sm text-[#e8e8f0] font-medium leading-tight">{o.label}</p>
                <p className="text-xs text-[#7070a0] mt-0.5">{o.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Title */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label>Title</Label>
          <CharCount value={title} max={60} />
        </div>
        <Input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
          placeholder="Notification title…"
        />
        {errors.title && <FieldError msg={errors.title} />}
      </div>

      {/* Body */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label>Body</Label>
          <CharCount value={body} max={200} />
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={200}
          rows={3}
          placeholder="Notification body text…"
          className={`${inputCls} resize-none`}
        />
        {errors.body && <FieldError msg={errors.body} />}
      </div>

      {/* Action URL */}
      <div>
        <Label>Action URL <span className="normal-case text-[#3a3a60] font-normal">(optional)</span></Label>
        <Input
          type="url"
          value={actionUrl}
          onChange={(e) => setActionUrl(e.target.value)}
          placeholder="https://…"
        />
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

      {/* Expires */}
      <div>
        <Label>Expires <span className="normal-case text-[#3a3a60] font-normal">(optional)</span></Label>
        <Input
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          min={new Date().toISOString().slice(0, 10)}
        />
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
