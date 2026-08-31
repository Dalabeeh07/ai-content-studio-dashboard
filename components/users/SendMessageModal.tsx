"use client";

import { FormEvent, useRef, useState } from "react";
import type { UserRow } from "@/lib/types";

interface Props {
  user: UserRow;
  onClose: () => void;
}

export default function SendMessageModal({ user, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const displayName = user.email ?? `User #${user.hwid.slice(0, 6)}`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/users/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hardware_id: user.hwid,
        message,
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
                Message
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={4}
                maxLength={500}
                placeholder="Notification message…"
                className="w-full bg-[#141428] border border-[#1e1e38] rounded-lg px-3 py-2
                           text-[#e8e8f0] text-sm placeholder-[#3a3a60] resize-none
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
