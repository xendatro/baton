/**
 * In-memory token buckets (SPEC §5 rate limits). One limiter instance per app, so tests and the
 * process never share state. A bucket holds up to `max` tokens and refills continuously at
 * `max` per `windowMs`; each request takes one token.
 */

export interface RateLimitRule {
  /** Burst size and requests allowed per window. */
  max: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until the next request would be allowed (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Takes a token from the bucket `key` (created full on first use). */
  consume(key: string, rule: RateLimitRule, now?: number): RateLimitDecision;
  /** Number of live buckets (for tests and diagnostics). */
  readonly size: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  rule: RateLimitRule;
}

/** Idle buckets are swept every this many `consume` calls. */
const SWEEP_EVERY = 1000;

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let calls = 0;

  function refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const rate = bucket.rule.max / bucket.rule.windowMs;
    bucket.tokens = Math.min(bucket.rule.max, bucket.tokens + elapsed * rate);
    bucket.updatedAt = now;
  }

  /** Drops buckets that have refilled completely: they behave exactly like new ones. */
  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      refill(bucket, now);
      if (bucket.tokens >= bucket.rule.max) buckets.delete(key);
    }
  }

  return {
    consume(key, rule, now = Date.now()) {
      calls += 1;
      if (calls % SWEEP_EVERY === 0) sweep(now);

      let bucket = buckets.get(key);
      if (!bucket || bucket.rule.max !== rule.max || bucket.rule.windowMs !== rule.windowMs) {
        bucket = { tokens: rule.max, updatedAt: now, rule };
        buckets.set(key, bucket);
      } else {
        refill(bucket, now);
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
      }
      const rate = rule.max / rule.windowMs;
      const waitMs = (1 - bucket.tokens) / rate;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    },
    get size() {
      return buckets.size;
    },
  };
}
