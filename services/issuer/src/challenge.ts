// Stateless HMAC challenges (PLAN §8.4 rule 1). A challenge is the request's <nonce>:
//   nonce = rand(16) || expiry (u64 BE, unix seconds) || HMAC-SHA256(secret, domain || rand || expiry)[0..16]    = 40 bytes
// The domain binds network and issuer, so a challenge from one issuer (or network) is useless at another. No server state:
// replays inside the TTL are harmless because the request also binds SHA256(blindedMsg) and the token store deduplicates.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const NONCE_LEN = 40;

export class Challenges {
  readonly #secret: Uint8Array;
  readonly #domain: Uint8Array;
  readonly ttlSec: number;

  constructor(secret: Uint8Array | null, domain: string, ttlSec: number) {
    if (secret && secret.length < 32) throw new Error('challenge secret must be at least 32 bytes');
    this.#secret = secret ?? new Uint8Array(randomBytes(32));
    this.#domain = new TextEncoder().encode(`govhub-issuer-challenge-v1|${domain}|`);
    this.ttlSec = ttlSec;
  }

  #tag(rand: Uint8Array, expiry: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac('sha256', this.#secret).update(this.#domain).update(rand).update(expiry).digest().subarray(0, 16));
  }

  issue(nowSec: number): { nonce: Uint8Array; expiresAt: number } {
    const rand = new Uint8Array(randomBytes(16));
    const expiresAt = nowSec + this.ttlSec;
    const expiry = new Uint8Array(8);
    new DataView(expiry.buffer).setBigUint64(0, BigInt(expiresAt), false);
    const nonce = new Uint8Array(NONCE_LEN);
    nonce.set(rand, 0);
    nonce.set(expiry, 16);
    nonce.set(this.#tag(rand, expiry), 24);
    return { nonce, expiresAt };
  }

  /** Authentic, not expired, and not issued further ahead than this server's TTL. */
  check(nonce: Uint8Array, nowSec: number): boolean {
    if (nonce.length !== NONCE_LEN) return false;
    const rand = nonce.subarray(0, 16);
    const expiry = nonce.subarray(16, 24);
    const ok = timingSafeEqual(this.#tag(rand, expiry), nonce.subarray(24, 40));
    const at = Number(new DataView(expiry.buffer, expiry.byteOffset, 8).getBigUint64(0, false));
    return ok && at >= nowSec && at <= nowSec + this.ttlSec + 5;
  }
}
