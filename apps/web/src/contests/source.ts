// Contest reads. Live: evo-sdk's proof-verifying queries on the profile's Platform network (the same SDK as every other read).
// Fixtures: a small fixed set, for tests and screenshots. Open contests are one query; ended ones are only read when asked for.
import type { Registry } from '../config/registry.ts';
import type { CoreNetwork } from '../data/types.ts';
import { getSdk } from '../data/platform.ts';
import { loadFixtures } from '../data/fixtures.ts';
import { DPNS_CONTRACT_ID, DPNS_POLL, PARENT_DOMAIN, toOutcome, type ContestState, type Contender, type OpenContest, type Outcome } from './model.ts';
import { FIXTURE_CONTESTS } from './fixtures.ts';

export interface NamesPage {
  /** normalized labels, in index (name) order */
  labels: string[];
  /** pass as `after` for the next page; null at the end */
  next: string | null;
}

export interface ContestSource {
  /** The Platform network the contests are on. */
  readonly network: CoreNetwork;
  readonly scope: string;
  /** Contests still open for votes, soonest closing first. */
  open(): Promise<OpenContest[]>;
  /**
   * Every contested name (open or decided), in name order: from the start, after `after` (exclusive), or from `from` (inclusive,
   * to jump to a name).
   */
  names(at?: { after?: string; from?: string }): Promise<NamesPage>;
  /** Tallies, contenders and outcome of one contest. Cached for a minute. */
  state(label: string): Promise<ContestState>;
  /** The cached state, if it is still fresh. */
  peek(label: string): ContestState | undefined;
  /** Drops the cached state of one contest (after a vote) or of all. */
  forget(label?: string): void;
}

export const NAMES_PAGE = 100;
const OPEN_PAGE = 100;
const OPEN_MAX_PAGES = 20;
const TTL_MS = 60_000;

/** WASM SDK errors are wasm-bindgen objects, not Error instances. */
export function sdkError(e: unknown): Error {
  if (e instanceof Error) return e;
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  return new Error(m);
}

/** Index values arrive as strings in SDK 5; older shapes (arrays, serialized values) are tolerated where cheap. */
function labelOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    const last = entry[entry.length - 1];
    if (typeof last === 'string') return last;
  }
  return undefined;
}

interface Cached<T> {
  at: number;
  p: Promise<T>;
  value?: T;
}

/** A small TTL cache of promises: concurrent callers share one read, and a failed read is not kept. */
export class TtlCache<T> {
  private readonly m = new Map<string, Cached<T>>();
  constructor(private readonly ttl: number, private readonly clock: () => number = Date.now) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    if (hit && this.clock() - hit.at < this.ttl) return hit.p;
    const entry: Cached<T> = { at: this.clock(), p: load() };
    this.m.set(key, entry);
    entry.p.then(
      (v) => (entry.value = v),
      () => this.m.get(key) === entry && this.m.delete(key),
    );
    return entry.p;
  }
  peek(key: string): T | undefined {
    const hit = this.m.get(key);
    return hit && this.clock() - hit.at < this.ttl ? hit.value : undefined;
  }
  delete(key?: string): void {
    if (key === undefined) this.m.clear();
    else this.m.delete(key);
  }
}

// one cache per source scope, so a profile switch never shows another network's contests
const states = new Map<string, TtlCache<ContestState>>();
const opens = new Map<string, TtlCache<OpenContest[]>>();
const cacheFor = <T>(all: Map<string, TtlCache<T>>, scope: string): TtlCache<T> => {
  let c = all.get(scope);
  if (!c) all.set(scope, (c = new TtlCache<T>(TTL_MS)));
  return c;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

type Sdk = Awaited<ReturnType<typeof getSdk>>;

/** The spelling of `label`.dash as registered, when `ownerId` holds it (a proved read of its DPNS domain document). */
async function registeredSpelling(sdk: Sdk, label: string, ownerId: string): Promise<string | undefined> {
  const res = await sdk.documents.queryWithProof({
    dataContractId: DPNS_CONTRACT_ID,
    documentTypeName: DPNS_POLL.documentTypeName,
    where: [
      ['normalizedParentDomainName', '==', PARENT_DOMAIN],
      ['normalizedLabel', '==', label],
    ],
    limit: 1,
  } as never);
  for (const d of res.data.values()) {
    const j = d?.toJSON() as { $ownerId?: string; label?: unknown; normalizedLabel?: unknown } | undefined;
    if (j?.$ownerId === ownerId && j.normalizedLabel === label && typeof j.label === 'string' && j.label.length <= 63) return j.label;
  }
  return undefined;
}

export function liveContests(r: Registry): ContestSource {
  const scope = `contests:${r.platformNetwork}:${JSON.stringify(r.platform)}`;
  const stateCache = cacheFor(states, scope);
  const openCache = cacheFor(opens, scope);
  let dpns: Promise<unknown> | null = null;
  const dpnsContract = async () => {
    dpns ??= getSdk(r).then((sdk) => sdk.contracts.fetch(DPNS_CONTRACT_ID));
    dpns.catch(() => (dpns = null));
    return dpns;
  };

  async function readOpen(): Promise<OpenContest[]> {
    const sdk = await getSdk(r);
    const out: OpenContest[] = [];
    const seen = new Set<string>();
    let start: number = Date.now();
    let included = true;
    for (let page = 0; page < OPEN_MAX_PAGES; page++) {
      const res = await sdk.voting.votePollsByEndDateWithProof({ startTimeMs: start, startTimeIncluded: included, orderAscending: true, limit: OPEN_PAGE }).catch((e: unknown) => {
        throw sdkError(e);
      });
      const buckets = res.data;
      for (const b of buckets) {
        const endsAt = num(b.timestampMs);
        if (endsAt === null) continue;
        start = endsAt;
        for (const poll of Array.from(b.votePolls ?? [])) {
          const p = (poll as { toJSON(): { contractId?: string; documentTypeName?: string; indexName?: string; indexValues?: unknown[] } }).toJSON();
          if (p.contractId !== DPNS_CONTRACT_ID || p.documentTypeName !== DPNS_POLL.documentTypeName || p.indexName !== DPNS_POLL.indexName) continue;
          const [parent, label] = p.indexValues ?? [];
          if (parent !== PARENT_DOMAIN || typeof label !== 'string' || seen.has(label)) continue;
          seen.add(label);
          out.push({ label, endsAt });
        }
      }
      if (buckets.length < OPEN_PAGE) break;
      included = false;
    }
    return out.sort((a, b) => a.endsAt - b.endsAt || a.label.localeCompare(b.label));
  }

  async function readState(label: string): Promise<ContestState> {
    const sdk = await getSdk(r);
    const [res, contract, mod] = await Promise.all([
      sdk.voting
        .contestedResourceVoteStateWithProof({
          ...DPNS_POLL,
          indexValues: [PARENT_DOMAIN, label],
          resultType: 'documentsAndVoteTally',
          includeLockedAndAbstaining: true,
          limit: 100,
        })
        .catch((e: unknown) => {
          throw sdkError(e);
        }),
      dpnsContract().catch(() => undefined),
      import('@dashevo/evo-sdk'),
    ]);
    const st = res.data;
    const version = sdk.version();
    const contenders: Contender[] = [];
    for (const raw of Array.from(st.contenders ?? [])) {
      const c = raw as { identityId?: { toString(): string }; voteTally?: number; serializedDocument?: Uint8Array };
      const identityId = c.identityId?.toString();
      if (!identityId) continue;
      let requested: string | undefined;
      // The contender's own spelling, from their document, decoded by the SDK (its bytes are never shown).
      if (contract && c.serializedDocument) {
        try {
          const doc = mod.Document.fromBytes(c.serializedDocument, contract as never, DPNS_POLL.documentTypeName, version);
          const l = doc.properties?.label;
          if (typeof l === 'string' && l.length <= 63) requested = l;
        } catch {
          // an undecodable document: the normalized label is shown
        }
      }
      contenders.push({ identityId, votes: num(c.voteTally) ?? 0, ...(requested ? { requested } : {}) });
    }
    contenders.sort((a, b) => b.votes - a.votes || a.identityId.localeCompare(b.identityId));
    const abstain = num(st.abstainVoteTally) ?? 0;
    const lock = num(st.lockVoteTally) ?? 0;
    let outcome: Outcome | null = null;
    const w = st.winner;
    if (w) outcome = toOutcome(w.kind, w.identityId?.toString(), num(w.block?.timeMs));
    // An awarded contest no longer carries the contenders' documents: the winner's spelling is in the name they now hold.
    if (outcome?.kind === 'won') {
      const winner = contenders.find((c) => c.identityId === (outcome as { identityId: string }).identityId);
      if (winner && !winner.requested) {
        const held = await registeredSpelling(sdk, label, winner.identityId).catch(() => undefined);
        if (held) winner.requested = held;
      }
    }
    const h = num(res.metadata?.height);
    return { label, contenders, abstain, lock, total: contenders.reduce((s, c) => s + c.votes, 0) + abstain + lock, outcome, height: h };
  }

  return {
    network: r.platformNetwork,
    scope,
    open: () => openCache.get('open', readOpen),
    async names(at = {}) {
      const sdk = await getSdk(r);
      const cursor = at.from ?? at.after;
      const res = await sdk.group
        .contestedResourcesWithProof({
          ...DPNS_POLL,
          startIndexValues: [PARENT_DOMAIN],
          limit: NAMES_PAGE,
          ...(cursor !== undefined ? { startAtValue: cursor, startAtValueIncluded: at.from !== undefined } : {}),
        })
        .catch((e: unknown) => {
          throw sdkError(e);
        });
      const labels = (res.data as unknown[]).map(labelOf).filter((l): l is string => !!l);
      return { labels, next: (res.data as unknown[]).length < NAMES_PAGE ? null : (labels.at(-1) ?? null) };
    },
    state: (label) => stateCache.get(label, () => readState(label)),
    peek: (label) => stateCache.peek(label),
    forget: (label) => stateCache.delete(label),
  };
}

/** Fixtures: end times are relative to the snapshot's frozen clock. */
export function fixtureContests(): ContestSource {
  const at = async () => (await loadFixtures()).now * 1000;
  const all = FIXTURE_CONTESTS;
  const sorted = [...all].sort((a, b) => a.label.localeCompare(b.label));
  return {
    network: 'mainnet',
    scope: 'contests:fixtures',
    async open() {
      const now = await at();
      return all
        .filter((c) => c.endsInMs !== null)
        .map((c) => ({ label: c.label, endsAt: now + c.endsInMs! }))
        .sort((a, b) => a.endsAt - b.endsAt);
    },
    async names(q = {}) {
      const from = q.from ?? q.after;
      const rest = from === undefined ? sorted : sorted.filter((c) => (q.from !== undefined ? c.label >= from : c.label > from));
      const labels = rest.slice(0, NAMES_PAGE).map((c) => c.label);
      return { labels, next: rest.length > NAMES_PAGE ? labels.at(-1)! : null };
    },
    async state(label) {
      const now = await at();
      const c = all.find((x) => x.label === label);
      if (!c) return { label, contenders: [], abstain: 0, lock: 0, total: 0, outcome: null, height: null };
      const outcome = c.outcome ? ({ ...c.outcome, at: c.outcome.agoMs === null ? null : now - c.outcome.agoMs } as Outcome) : null;
      const total = c.contenders.reduce((s, x) => s + x.votes, 0) + c.abstain + c.lock;
      return { label, contenders: [...c.contenders].sort((a, b) => b.votes - a.votes), abstain: c.abstain, lock: c.lock, total, outcome, height: 459_350 };
    },
    peek: () => undefined,
    forget: () => {},
  };
}
