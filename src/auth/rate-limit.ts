/**
 * A tiny in-memory fixed-window rate limiter.
 *
 * Used to blunt brute-force login attempts: a handful of tries per IP per window,
 * then `429` until the window rolls over. In-process state is fine for the MVP's
 * single instance; a multi-replica deployment would move this to Redis.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Record a hit for `key`; returns whether it is allowed (under the limit). */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(maxHits: number, windowMs: number): RateLimiter {
  const windows = new Map<string, Window>();

  // Opportunistically evict stale windows so the map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, win] of windows) if (now > win.resetAt) windows.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    hit(key: string) {
      const now = Date.now();
      const existing = windows.get(key);
      if (!existing || now > existing.resetAt) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      existing.count += 1;
      if (existing.count > maxHits) {
        return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
