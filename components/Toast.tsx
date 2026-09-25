"use client";

import { useCallback, useRef, useState } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
  /** Optional button (e.g. "Undo"); such toasts stay longer by default. */
  action?: ToastAction;
}

/** Local (non-global) toast queue - scoped to whichever component tree
 * calls this hook. There's no cross-page toast system in this dashboard
 * yet; this is deliberately minimal rather than a new app-wide provider,
 * since nothing outside Submissions needs one today. */
export function useToasts(autoDismissMs = 6000) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback(
    (message: string, kind: ToastItem["kind"] = "info", action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, message, kind, action }]);
      const ms = action ? Math.max(autoDismissMs, 20000) : kind === "error" ? Math.max(autoDismissMs, 10000) : autoDismissMs;
      if (ms > 0) {
        setTimeout(() => {
          setToasts((t) => t.filter((x) => x.id !== id));
        }, ms);
      }
    },
    [autoDismissMs]
  );

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

const KIND_STYLES: Record<ToastItem["kind"], string> = {
  info: "bg-[#0f1a2a] border-brand-blue/40 text-brand-blue",
  success: "bg-[#0f2a1a] border-brand-mint/40 text-brand-mint",
  error: "bg-[#2a1010] border-brand-orange/40 text-brand-orange",
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 px-4 py-3 rounded-xl
                      text-sm font-medium border shadow-lg animate-toast-in
                      ${KIND_STYLES[t.kind]}`}
        >
          <span className="mt-0.5">{t.kind === "success" ? "✓" : t.kind === "error" ? "⚠" : "🔔"}</span>
          <button onClick={() => onDismiss(t.id)} title="Click to dismiss" className="flex-1 text-left">
            {t.message}
          </button>
          {t.action && (
            <button
              onClick={() => { t.action?.onClick(); onDismiss(t.id); }}
              className="shrink-0 px-2 py-0.5 rounded border border-current text-xs font-semibold hover:bg-white/10"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
