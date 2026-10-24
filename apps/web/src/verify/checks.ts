// Which proposals passed local verification, for hiding the ones that did not (lists, budget header, active count).
//   - synchronous: the gov hash recomputes and the published fields equal the hashed data (no network);
//   - in the background: the collateral check in the worker, a few at a time, its result cached per govHash in IndexedDB.
// A proposal whose collateral check has not finished is "pending" and stays listed, so lists never empty out while checks run.
import type { Proposal } from '../data/types.ts';
import { checkContent, verdictFailure, type CollateralVerdict } from './collateral.ts';

export type CheckState =
  | { status: 'pending' }
  | { status: 'ok' }
  /** The check could not run to a conclusion (nodes unreachable): listed as usual, retried next time. */
  | { status: 'inconclusive'; reason: string }
  | { status: 'failed'; reason: string };

export const isFailed = (c: CheckState): c is Extract<CheckState, { status: 'failed' }> => c.status === 'failed';

const contentMemo = new WeakMap<Proposal, string | null>();

/** Why the published proposal does not match what its gov hash commits to, or null. Memoised per proposal object. */
export function contentFailure(p: Proposal): string | null {
  let r = contentMemo.get(p);
  if (r === undefined) {
    const bad = checkContent(p).steps.filter((s) => s.status !== 'ok');
    r = bad.length ? bad.map((s) => `${s.label}: ${s.detail}`).join('; ') : null;
    contentMemo.set(p, r);
  }
  return r;
}

export interface StoredCheck {
  status: 'ok' | 'failed';
  reason?: string;
  /** ms */
  at: number;
}

export interface CheckCache {
  get(key: string): Promise<StoredCheck | undefined>;
  put(key: string, value: StoredCheck): Promise<void>;
}

/** How long a cached result stands before it is checked again in the background (it is still used meanwhile). */
export const CHECK_TTL_MS: Record<StoredCheck['status'], number> = { ok: 7 * 86_400_000, failed: 86_400_000 };

export interface ProposalChecksOptions {
  /** Cache namespace: the data source's scope (profile, networks, contract) and the DAPI nodes asked. */
  scope: string;
  /** The collateral check (the worker, in the app). */
  run(p: Proposal): Promise<CollateralVerdict>;
  cache?: CheckCache;
  concurrency?: number;
  now?: () => number;
}

/** Results by scope, shared by the instances of one session: a rebuilt data source does not flash hidden proposals back as pending. */
const memory = new Map<string, Map<string, CheckState>>();
/** Tests: start from an empty session. */
export const forgetCheckResults = (): void => memory.clear();

export class ProposalChecks {
  private readonly states: Map<string, CheckState>;
  private readonly seen = new Set<string>();
  /** Keys a full (block-proven) check has decided: a light background result never overrides those. */
  private readonly full = new Set<string>();
  private disposed = false;
  private readonly queue: Proposal[] = [];
  private running = 0;
  private readonly listeners = new Set<() => void>();
  private notifyScheduled = false;
  /** Bumped on every change (for useSyncExternalStore). */
  version = 0;

  constructor(private readonly o: ProposalChecksOptions) {
    let m = memory.get(o.scope);
    if (!m) memory.set(o.scope, (m = new Map()));
    this.states = m;
  }

  /** Stops background work (the data source was replaced): queued checks are dropped, results are no longer reported. */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.listeners.clear();
  }

  private key = (p: Proposal) => `${this.o.scope}:check:${p.govHash}:${p.collateralTxid}`;
  private now = () => (this.o.now ?? Date.now)();

  state(p: Proposal): CheckState {
    const content = contentFailure(p);
    if (content) return { status: 'failed', reason: content };
    return this.states.get(this.key(p)) ?? { status: 'pending' };
  }

  /** Starts the checks these proposals still need: cached results first, then the worker for the rest, `concurrency` at a time. */
  ensure(ps: readonly Proposal[]): void {
    for (const p of ps) {
      const k = this.key(p);
      if (this.seen.has(k) || contentFailure(p)) continue;
      this.seen.add(k);
      void this.load(p, k);
    }
  }

  /** A full check that ran elsewhere (the proposal page) counts too, and outranks the light background check of the same proposal. */
  record(p: Proposal, v: CollateralVerdict, o: { full?: boolean } = {}): void {
    const k = this.key(p);
    this.seen.add(k);
    if (this.disposed || (!o.full && this.full.has(k))) return;
    if (o.full && !v.inconclusive) this.full.add(k);
    const reason = verdictFailure(v);
    if (v.ok || reason) {
      const stored: StoredCheck = v.ok ? { status: 'ok', at: this.now() } : { status: 'failed', reason: reason!, at: this.now() };
      this.set(k, toState(stored));
      void this.o.cache?.put(k, stored).catch(() => {});
    } else if (this.states.get(k)?.status !== 'ok' && this.states.get(k)?.status !== 'failed') {
      // Inconclusive never overrides a definite earlier result.
      this.set(k, { status: 'inconclusive', reason: v.steps.find((s) => s.status === 'fail')?.detail ?? 'the check did not complete' });
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private async load(p: Proposal, k: string): Promise<void> {
    const cached = await this.o.cache?.get(k).catch(() => undefined);
    if (this.disposed) return;
    if (cached) {
      this.set(k, toState(cached));
      if (this.now() - cached.at < CHECK_TTL_MS[cached.status]) return;
    }
    this.queue.push(p);
    this.pump();
  }

  private pump(): void {
    const limit = this.o.concurrency ?? 2;
    while (!this.disposed && this.running < limit && this.queue.length) {
      const p = this.queue.shift()!;
      this.running++;
      this.o
        .run(p)
        .then(
          (v) => this.record(p, v),
          (e: unknown) => this.record(p, { ok: false, inconclusive: true, steps: [{ id: 'tx', status: 'fail', label: 'Collateral check', detail: e instanceof Error ? e.message : String(e) }] }),
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private set(k: string, s: CheckState): void {
    const old = this.states.get(k);
    if (old && old.status === s.status && ('reason' in old ? old.reason : '') === ('reason' in s ? s.reason : '')) return;
    this.states.set(k, s);
    this.version++;
    // Many results land together (cached reads): one notification per tick.
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const fn of this.listeners) fn();
    });
  }
}

const toState = (s: StoredCheck): CheckState => (s.status === 'ok' ? { status: 'ok' } : { status: 'failed', reason: s.reason ?? 'failed verification' });
