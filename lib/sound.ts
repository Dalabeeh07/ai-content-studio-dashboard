import { useSyncExternalStore } from "react";

// Synthesized notification chime via the Web Audio API - no audio asset
// to bundle, host, or fail to load. Two short sine-wave notes, matching
// the "brief, unobtrusive" alert this dashboard's Submissions page needs
// when a new video link comes in.
let audioCtx: AudioContext | null = null;
let unlocked = false;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

/** Most browsers refuse to start an AudioContext before the user has
 * interacted with the page at all. Call this once, e.g. on the page's
 * first click anywhere, so a chime triggered later (by a Realtime event
 * with no user gesture behind it) has a real chance of actually playing
 * instead of silently staying suspended. Safe to call repeatedly. */
export function unlockAudioOnNextInteraction(): void {
  if (unlocked || typeof window === "undefined") return;
  const tryResume = () => {
    const ctx = getContext();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    unlocked = true;
    window.removeEventListener("pointerdown", tryResume);
    window.removeEventListener("keydown", tryResume);
  };
  window.addEventListener("pointerdown", tryResume, { once: true });
  window.addEventListener("keydown", tryResume, { once: true });
}

export function playNotificationChime(): void {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const notes = [
    { freq: 880, start: 0, duration: 0.12 },
    { freq: 1318.5, start: 0.09, duration: 0.16 },
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const startAt = ctx.currentTime + note.start;

    osc.type = "sine";
    osc.frequency.value = note.freq;

    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(0.18, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + note.duration + 0.02);
  }
}

// ── Mute preference (persisted, localStorage) ───────────────────────────────
//
// Read via useSyncExternalStore rather than a useEffect+setState pair:
// localStorage doesn't exist during SSR, and a useEffect-based read would
// mean the very first client render (hydration) has to match whatever
// the server rendered (always "unmuted", since the server has no
// storage) before correcting itself a tick later - the classic
// SSR/CSR-mismatch trap. useSyncExternalStore's getServerSnapshot gives
// React that same safe "unmuted" value for the hydration pass itself, so
// there's no mismatch to correct in the first place.
const MUTE_STORAGE_KEY = "submissions:sound-muted";
const muteListeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeMuted(listener: () => void): () => void {
  muteListeners.add(listener);
  return () => muteListeners.delete(listener);
}

function getServerSnapshot(): boolean {
  return false;
}

export function useSoundMuted(): [boolean, (next: boolean) => void] {
  const muted = useSyncExternalStore(subscribeMuted, readMuted, getServerSnapshot);

  function setMuted(next: boolean): void {
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Storage blocked (private browsing, quota, etc.) - the toggle just
      // won't persist across reloads this session; still notify listeners
      // so readMuted() is re-checked (it will report the same value it
      // did before, since the write above never landed - a harmless no-op).
    }
    muteListeners.forEach((listener) => listener());
  }

  return [muted, setMuted];
}
