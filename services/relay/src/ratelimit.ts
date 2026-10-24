// In-memory rate limiters. Nothing here is ever written to disk or logged.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import type { Clock } from './log.ts';

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token bucket per client IP: `perMin` tokens per minute, bursts up to `perMin`. Buckets are keyed by HMAC-SHA256(salt, ip) with a
 * random per-process salt, so the map holds no address, and a heap dump after a restart cannot be matched against a list of IPs.
 */
export class IpLimiter {
  private readonly perMin: number;
  private readonly clock: Clock;
  private readonly salt = randomBytes(32);
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(perMin: number, clock: Clock) {
    this.perMin = perMin;
    this.clock = clock;
    this.lastSweep = clock();
  }

  private key(ip: string): string {
    return Buffer.from(hmac(sha256, this.salt, new TextEncoder().encode(ip))).toString('base64');
  }

  /** Takes a token. Returns 0 if allowed, else the number of whole seconds until a token is available. */
  take(ip: string): number {
    const now = this.clock();
    this.sweep(now);
    const k = this.key(ip);
    const rate = this.perMin / 60;
    const b = this.buckets.get(k) ?? { tokens: this.perMin, at: now };
    b.tokens = Math.min(this.perMin, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(k, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate));
  }

  /** Drops buckets that have refilled completely (they carry no information any more). */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60) return;
    this.lastSweep = now;
    // an idle bucket is full again after 60 s whatever the rate
    for (const [k, b] of this.buckets) if (now - b.at >= 60) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** At most `limit` accepted submissions per key (masternode outpoint) in any rolling hour. */
export class RollingHourLimiter {
  private readonly limit: number;
  private readonly clock: Clock;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, clock: Clock) {
    this.limit = limit;
    this.clock = clock;
  }

  private recent(key: string): number[] {
    const cutoff = this.clock() - 3600;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** True if another submission would exceed the limit. */
  exceeded(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  /** Seconds until the oldest counted submission leaves the window. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    return list.length ? Math.max(1, list[0]! + 3600 - this.clock()) : 1;
  }

  record(key: string): void {
    const list = this.recent(key);
    list.push(this.clock());
    this.hits.set(key, list);
  }
}
