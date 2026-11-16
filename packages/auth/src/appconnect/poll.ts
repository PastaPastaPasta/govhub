// Finding the wallet's answer (DIP pasta-app-connect, "App Processing of connect", Polling): page through every response to the
// request hash, verify each new one, and give up after 10 minutes or 20 candidates. Nothing here decides who signed in.
import { bytesToHex, concatBytes, fromBase58, toBase58 } from '../bytes.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { requestHash, type ConnectRequest } from './codec.ts';
import type { AppConnectPort, Candidate } from './port.ts';
import { verifyCandidate, type Grant, type RejectReason } from './verify.ts';

export const PAGE_SIZE = 10;
export const MAX_CANDIDATES = 20;
export const GIVE_UP_MS = 10 * 60_000;
export const FAST_POLL_MS = 2_000;
export const SLOW_POLL_MS = 4_000;
const FAST_WINDOW_MS = 60_000;
/** A key the app's node does not show yet is looked for again for this long (the wallet's node may be ahead). */
export const RETRY_WINDOW_MS = 30_000;

/** Byte order of two base58 ids, as Platform orders `$ownerId`. */
export function compareIds(a: string, b: string): number {
  const x = fromBase58(a);
  const y = fromBase58(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Every candidate, in owner order; `truncated` when there are more than `max` (spam: start a new request). */
export async function listCandidates(port: AppConnectPort, hash: Uint8Array, o: { hint?: string; max?: number } = {}): Promise<{ candidates: Candidate[]; truncated: boolean }> {
  const max = o.max ?? MAX_CANDIDATES;
  const out: Candidate[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await port.responses(hash, { ...(o.hint ? { hint: o.hint } : after ? { startAfter: after } : {}), limit: PAGE_SIZE });
    for (const c of page) {
      // a node that ignores the cursor would loop forever, one that ignores the hint would show someone else
      if (after !== undefined && compareIds(c.ownerId, after) <= 0) return { candidates: out, truncated: false };
      after = c.ownerId;
      if (o.hint && c.ownerId !== o.hint) continue;
      if (out.length === max) return { candidates: out, truncated: true };
      out.push(c);
    }
    if (page.length < PAGE_SIZE || o.hint) return { candidates: out, truncated: false };
  }
}

const candidateKey = (c: Candidate) => `${c.ownerId}:${bytesToHex(sha256(concatBytes(c.walletEphemeralPubKey, c.encryptedPayload)))}`;

/** The delay before the next poll, or null once the request is older than 10 minutes. */
export function pollDelay(elapsedMs: number): number | null {
  if (elapsedMs >= GIVE_UP_MS) return null;
  return elapsedMs < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

export type PollEvent =
  | { type: 'grant'; grant: Grant }
  | { type: 'rejected'; ownerId: string; reason: RejectReason }
  | { type: 'error'; error: unknown }
  | { type: 'gave-up'; why: 'expired' | 'too-many' };

export interface Poller {
  /** Polls now (focus regained, or the user said they approved). */
  poke(): void;
  stop(): void;
}

/**
 * Polls until stopped or given up. Each verified grant is reported once (several may verify: the caller asks the user which one);
 * a candidate rejected for a reason a lagging node can cause is checked again for RETRY_WINDOW_MS, any other rejection is final.
 */
export function startPolling(o: {
  request: ConnectRequest;
  appEphemeralPrivateKey: Uint8Array;
  port: AppConnectPort;
  onEvent(e: PollEvent): void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Poller {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const hash = requestHash(o.request);
  const hint = o.request.identityHint ? toBase58(o.request.identityHint) : undefined;
  const started = o.request.createdAt;
  const done = new Set<string>();
  const firstSeen = new Map<string, number>();
  let stopped = false;
  let running = false;
  let again = false;
  let timer: unknown = null;

  const emit = (e: PollEvent) => {
    if (!stopped) o.onEvent(e);
  };
  const giveUp = (why: 'expired' | 'too-many') => {
    emit({ type: 'gave-up', why });
    stop();
  };
  const schedule = () => {
    if (stopped) return;
    const d = pollDelay(now() - started);
    if (d === null) return giveUp('expired');
    timer = setTimer(() => void tick(), d);
  };
  async function tick() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (timer !== null) clearTimer(timer);
    timer = null;
    running = true;
    try {
      if (now() - started >= GIVE_UP_MS) return giveUp('expired');
      const { candidates, truncated } = await listCandidates(o.port, hash, hint ? { hint } : {});
      for (const c of candidates) {
        if (stopped) return;
        const k = candidateKey(c);
        if (done.has(k)) continue;
        const v = await verifyCandidate({ request: o.request, appEphemeralPrivateKey: o.appEphemeralPrivateKey, candidate: c, port: o.port });
        if (v.ok) {
          done.add(k);
          emit({ type: 'grant', grant: v.grant });
          continue;
        }
        const seen = firstSeen.get(k) ?? now();
        firstSeen.set(k, seen);
        if (!v.retryable || now() - seen > RETRY_WINDOW_MS) {
          done.add(k);
          emit({ type: 'rejected', ownerId: c.ownerId, reason: v.reason });
        }
      }
      if (truncated) return giveUp('too-many');
    } catch (error) {
      emit({ type: 'error', error });
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      return void tick();
    }
    schedule();
  }
  function stop() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  void tick();
  return { poke: () => void tick(), stop };
}

