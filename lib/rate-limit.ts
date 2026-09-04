const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(key: string): {
  allowed: boolean;
  retryAfterMinutes: number;
} {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMinutes: 0 };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfterMinutes = Math.ceil((entry.windowStart + WINDOW_MS - now) / 60000);
    return { allowed: false, retryAfterMinutes };
  }

  entry.count += 1;
  return { allowed: true, retryAfterMinutes: 0 };
}

export function resetRateLimit(key: string): void {
  attempts.delete(key);
}
