/**
 * Token bucket per key (a client's unique ID): `capacity` requests at once, then one more
 * every `refillMs`. Keeps one user from tying up yt-dlp for everyone.
 */
export class RateLimiter {
  #buckets = new Map(); // key -> { tokens, at }

  constructor({ capacity = 5, refillMs = 6_000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.now = now;
  }

  /** Takes a token for `key`; false when the bucket is empty. */
  take(key) {
    const now = this.now();
    const b = this.#buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) / this.refillMs);
    b.at = now;
    this.#buckets.set(key, b);
    if (this.#buckets.size > 1000) this.#prune(now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #prune(now) {
    for (const [key, b] of this.#buckets) {
      if (b.tokens + (now - b.at) / this.refillMs >= this.capacity) this.#buckets.delete(key);
    }
  }
}
