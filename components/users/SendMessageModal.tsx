"use client";

import { FormEvent, useRef, useState } from "react";
import type { UserRow } from "@/lib/types";

interface Props {
  user: UserRow;
  onClose: () => void;
}

const TYPE_OPTIONS = [
  { value: "message",  label: "📢 Message" },
  { value: "campaign", label: "💰 Campaign" },
  { value: "update",   label: "🔄 Update" },
];

export default function SendMessageModal({ user, onClose }: Props) {
  const [type, setType]     = useState("message");
  const [title, setTitle]   = useState("");
  const [body, setBody]     = useState("");
  const [url, setUrl]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");
  const [success, setSuccess] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const displayName = user.whop_username
    ? `@${user.whop_username}`
    : `User #${user.hardware_id.slice(0, 6)}`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/users/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hardware_id: user.hardware_id,
        type,
        title,
        body,
        action_url: url || undefined,
      }),
    });

    if (res.ok) {
      setSuccess(true);
      setTimeout(onClose, 1200);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Failed to send");
    }
    setLoading(false);
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="w-full max-w-md bg-[#0f0f1c] border border-[#1e1e38] rounded-2xl p-6 shadow-2xl">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-white font-bold text-lg">Send Message</h2>
            <p className="text-[#7070a0] text-sm mt-0.5">To {displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[#7070a0] hover:text-white transition-colors text-xl leading-none mt-0.5"
          >
            ✕
          </button>
        </div>

        {success ? (
          <p className="text-brand-mint text-center py-6 text-lg font-semibold">
            ✓ Message sent!
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-[#7070a0] text-xs mb-1.5 uppercase tracking-wide">
                Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full bg-[#141428] border border-[#1e1e38] rounded-lg px-3 py-2
                           text-[#e8e8f0] text-sm focus:outline-none focus:border-[#4a9eff]"
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[#7070a0] text-xs mb-1.5 uppercase tracking-wide">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={120}
                placeholder="Notification title"
                className="w-full bg-[#141428] border border-[#1e1e38] rounded-lg px-3 py-2
                           text-[#e8e8f0] text-sm placeholder-[#3a3a60]
                           focus:outline-none focus:border-[#4a9eff]"
              />
            </div>

            <div>
              <label className="block text-[#7070a0] text-xs mb-1.5 uppercase tracking-wide">
                Body
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                rows={3}
                maxLength={500}
                placeholder="Message body…"
                className="w-full bg-[#141428] border border-[#1e1e38] rounded-lg px-3 py-2
                           text-[#e8e8f0] text-sm placeholder-[#3a3a60] resize-none
                           focus:outline-none focus:border-[#4a9eff]"
              />
            </div>

            <div>
              <label className="block text-[#7070a0] text-xs mb-1.5 uppercase tracking-wide">
                Action URL <span className="normal-case">(optional)</span>
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="w-full bg-[#141428] border border-[#1e1e38] rounded-lg px-3 py-2
                           text-[#e8e8f0] text-sm placeholder-[#3a3a60]
                           focus:outline-none focus:border-[#4a9eff]"
              />
            </div>

            {error && (
              <p className="text-brand-orange text-sm">{error}</p>
            )}

            <div className="flex gap-3 justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-[#7070a0]
                           hover:text-white border border-[#1e1e38] hover:border-[#3a3a60]
                           transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white
                           bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60]
                           transition-colors"
              >
                {loading ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
