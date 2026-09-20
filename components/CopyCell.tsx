"use client";

import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/** Falls back to the deprecated but broadly-supported execCommand path
 * when the async Clipboard API is unavailable or denied (observed for
 * real: some embedded/automated browser contexts deny
 * `navigator.clipboard.writeText` with NotAllowedError even over a real
 * click, where this legacy path still works). */
function legacyCopy(value: string): boolean {
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** Copies `value` to the clipboard and reports back a brief "copied" (or
 * "failed") state that clears itself after `resetMs`. Shared by every
 * click-to-copy control in the dashboard (UsersTable's hwid/license-key
 * cells, SubmissionsTable's link cell) so the copy/flash timing behaves
 * identically everywhere. */
export function useCopyToClipboard(resetMs = 1500): [CopyState, (value: string) => void] {
  const [state, setState] = useState<CopyState>("idle");

  function flash(next: CopyState) {
    setState(next);
    setTimeout(() => setState("idle"), resetMs);
  }

  function copy(value: string) {
    if (!navigator.clipboard?.writeText) {
      flash(legacyCopy(value) ? "copied" : "failed");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => flash("copied"),
      () => flash(legacyCopy(value) ? "copied" : "failed")
    );
  }

  return [state, copy];
}

/** A cell whose entire display text is the click target - click it to
 * copy `value` (or `display`, if you want to show something shorter than
 * the real value, e.g. a truncated hwid). */
export function CopyCell({ value, display }: { value: string; display?: string }) {
  const [state, copy] = useCopyToClipboard();
  return (
    <button
      onClick={() => copy(value)}
      title="Click to copy"
      className="font-mono text-xs text-[#7070a0] hover:text-brand-blue transition-colors"
    >
      {state === "copied" ? "✓ copied" : state === "failed" ? "✗ copy failed" : (display ?? value)}
    </button>
  );
}
