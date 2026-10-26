// Contest reads. Live: evo-sdk's proof-verifying queries on the profile's Platform network (the same SDK as every other read).
// Fixtures: a small fixed set, for tests and screenshots. Open contests are one query; ended ones are only read when asked for.
import type { Registry } from '../config/registry.ts';
import type { CoreNetwork } from '../data/types.ts';
import { getSdk, type Sdk } from '../data/platform.ts';
import { loadFixtures } from '../data/fixtures.ts';
import { DPNS_CONTRACT_ID, DPNS_POLL, PARENT_DOMAIN, toOutcome, type ContestState, type Contender, type OpenContest } from './model.ts';
import { FIXTURE_CONTESTS } from './fixtures.ts';
import { choiceFromJson, type Choice } from './vote.ts';

export interface NamesPage {
  /** normalized labels, in index (name) order */
  labels: string[];
  /** pass as `after` for the next page; null at the end */
  next: string | null;
}

export interface ContestSource {
  /** The Platform network the contests are on. */
  readonly network: CoreNetwork;
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
  /** Drops the cached state of one contest, so the next read is fresh. */
  forget(label: string): void;
  /** Each voter's current vote on this contest (null: none), proved. `state` is the contest's state (its contenders and totals). */
  votesOf(label: string, state: ContestState, voterIds: readonly string[]): Promise<Map<string, Choice | null>>;
  /** A voter identity's current nonce (0 for one that never voted). */
  nonceOf(voterId: string): Promise<bigint>;
  /** Sends a signed vote and waits for Platform's answer (throws Platform's error). Fixtures send nothing. */
  broadcast(st: Uint8Array): Promise<void>;
  /** False in fixture mode: nothing is sent. */
  readonly live: boolean;
}

export const NAMES_PAGE = 100;
const OPEN_PAGE = 100;
const OPEN_MAX_PAGES = 20;
const TTL_MS = 60_000;
/** Pages of one voter's votes read while looking for an abstain or lock (100 each; mainnet has had about a thousand contests). */
const VOTER_MAX_PAGES = 12;

/** Index values arrive as strings in SDK 5. */
const labelOf = (entry: unknown): string | undefined => (typeof entry === 'string' ? entry : undefined);

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
  delete(key: string): void {
    this.m.delete(key);
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
    // every poll seen, of any contract: the end-date index holds other apps' contested polls too, and they count as progress
    const seen = new Set<string>();
    // Whether Drive's limit counts end times or polls, a full page means "maybe more": the next one starts AT the last end time
    // (polls of one end time may be split across pages; `seen` drops the repeats) and the read stops once a page brings nothing new.
    // (So a single end time holding a full page of polls or more would cut the list there; Platform has never come close.)
    let start = Date.now();
    for (let page = 0; page < OPEN_MAX_PAGES; page++) {
      const res = await sdk.voting.votePollsByEndDateWithProof({ startTimeMs: start, startTimeIncluded: true, orderAscending: true, limit: OPEN_PAGE });
      const buckets = res.data;
      let polls = 0;
      let added = 0;
      for (const b of buckets) {
        const endsAt = num(b.timestampMs);
        if (endsAt === null) continue;
        start = Math.max(start, endsAt);
        for (const poll of Array.from(b.votePolls ?? [])) {
          polls++;
          const p = (poll as { toJSON(): { contractId?: string; documentTypeName?: string; indexName?: string; indexValues?: unknown[] } }).toJSON();
          const key = JSON.stringify([p.contractId, p.documentTypeName, p.indexName, p.indexValues]);
          if (seen.has(key)) continue;
          seen.add(key);
          added++;
          if (p.contractId !== DPNS_CONTRACT_ID || p.documentTypeName !== DPNS_POLL.documentTypeName || p.indexName !== DPNS_POLL.indexName) continue;
          const [parent, label] = p.indexValues ?? [];
          if (parent !== PARENT_DOMAIN || typeof label !== 'string') continue;
          out.push({ label, endsAt });
        }
      }
      if ((buckets.length < OPEN_PAGE && polls < OPEN_PAGE) || added === 0) break;
    }
    return out.sort((a, b) => a.endsAt - b.endsAt || a.label.localeCompare(b.label));
  }

  async function readState(label: string): Promise<ContestState> {
    const sdk = await getSdk(r);
    const [res, contract, mod] = await Promise.all([
      sdk.voting.contestedResourceVoteStateWithProof({
        ...DPNS_POLL,
        indexValues: [PARENT_DOMAIN, label],
        resultType: 'documentsAndVoteTally',
        includeLockedAndAbstaining: true,
        limit: 100,
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
    const w = st.winner;
    const outcome = w ? toOutcome(w.kind, w.identityId?.toString(), num(w.block?.timeMs)) : null;
    // An awarded contest no longer carries the contenders' documents: the winner's spelling is in the name they now hold.
    if (outcome?.kind === 'won') {
      const winner = contenders.find((c) => c.identityId === outcome.identityId);
      if (winner && !winner.requested) {
        const held = await registeredSpelling(sdk, label, winner.identityId).catch(() => undefined);
        if (held) winner.requested = held;
      }
    }
    return { label, contenders, abstain, lock, total: contenders.reduce((s, c) => s + c.votes, 0) + abstain + lock, outcome, height: num(res.metadata?.height) };
  }

  async function votesOf(label: string, state: ContestState, voterIds: readonly string[]): Promise<Map<string, Choice | null>> {
    const sdk = await getSdk(r);
    const want = new Set(voterIds);
    const out = new Map<string, Choice | null>();
    // the voters of each contender (one query per hundred voters) settle every masternode that voted for someone
    for (const c of state.contenders) {
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await sdk.group.contestedResourceVotersForIdentityWithProof({
          ...DPNS_POLL,
          indexValues: [PARENT_DOMAIN, label],
          contestantId: c.identityId,
          limit: 100,
          ...(after ? { startAtVoterId: after, startAtIncluded: false } : {}),
        });
        const ids = (res.data as Array<{ toString(): string }>).map((x) => x.toString());
        for (const id of ids) if (want.has(id)) out.set(id, { kind: 'contender', identityId: c.identityId });
        if (ids.length < 100) break;
        after = ids.at(-1);
      }
    }
    // the rest voted abstain or lock, or not at all: only worth reading when the tally has abstain or lock votes
    const rest = voterIds.filter((v) => !out.has(v));
    if (state.abstain + state.lock === 0) {
      for (const v of rest) out.set(v, null);
      return out;
    }
    for (const v of rest) {
      let found: Choice | null = null;
      let after: string | undefined;
      for (let page = 0; page < VOTER_MAX_PAGES && !found; page++) {
        const res = await sdk.voting.contestedResourceIdentityVotesWithProof({ identityId: v, limit: 100, ...(after ? { startAtVoteId: after, startAtIncluded: false } : {}) });
        let last: string | undefined;
        for (const [k, rv] of res.data) {
          last = k;
          const j = (rv as { toJSON(): unknown }).toJSON() as { votePoll?: { contractId?: string; indexValues?: unknown[] }; resourceVoteChoice?: unknown };
          if (j.votePoll?.contractId === DPNS_CONTRACT_ID && j.votePoll.indexValues?.[1] === label) found = choiceFromJson(j.resourceVoteChoice);
        }
        if (res.data.size < 100 || !last) break;
        after = last;
      }
      out.set(v, found);
    }
    return out;
  }

  return {
    network: r.platformNetwork,
    live: true,
    votesOf,
    async nonceOf(voterId) {
      return (await (await getSdk(r)).identities.nonce(voterId)) ?? 0n;
    },
    async broadcast(st) {
      const sdk = await getSdk(r);
      const mod = await import('@dashevo/evo-sdk');
      const t = mod.StateTransition.fromBytes(st);
      try {
        await sdk.stateTransitions.broadcastAndWait(t);
      } finally {
        try {
          t.free();
        } catch {
          // consumed
        }
      }
    },
    open: () => openCache.get('open', readOpen),
    async names(at = {}) {
      const sdk = await getSdk(r);
      const cursor = at.from ?? at.after;
      const res = await sdk.group.contestedResourcesWithProof({
        ...DPNS_POLL,
        startIndexValues: [PARENT_DOMAIN],
        limit: NAMES_PAGE,
        ...(cursor !== undefined ? { startAtValue: cursor, startAtValueIncluded: at.from !== undefined } : {}),
      });
      const raw = res.data as unknown[];
      const labels = raw.map(labelOf).filter((l): l is string => !!l);
      // the next page starts after the last entry Platform returned
      return { labels, next: raw.length < NAMES_PAGE ? null : (labelOf(raw.at(-1)) ?? labels.at(-1) ?? null) };
    },
    state: (label) => stateCache.get(label, () => readState(label)),
    peek: (label) => stateCache.peek(label),
    forget: (label) => stateCache.delete(label),
  };
}

/** Fixtures: end times are relative to the snapshot's frozen clock. */
export function fixtureContests(): ContestSource {
  const at = async () => (await loadFixtures()).now * 1000;
  const sorted = [...FIXTURE_CONTESTS].sort((a, b) => a.label.localeCompare(b.label));
  return {
    network: 'mainnet',
    live: false,
    async votesOf(_label, _state, voterIds) {
      return new Map(voterIds.map((v) => [v, null]));
    },
    nonceOf: async () => 0n,
    broadcast: async () => {},
    async open() {
      const now = await at();
      return FIXTURE_CONTESTS.filter((c) => c.endsInMs !== null)
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
      const c = FIXTURE_CONTESTS.find((x) => x.label === label);
      if (!c) return { label, contenders: [], abstain: 0, lock: 0, total: 0, outcome: null, height: null };
      const o = c.outcome;
      const outcome = o ? toOutcome(o.kind === 'locked' ? 'Locked' : 'NoWinner', o.kind === 'won' ? o.identityId : undefined, o.agoMs === null ? null : now - o.agoMs) : null;
      const total = c.contenders.reduce((s, x) => s + x.votes, 0) + c.abstain + c.lock;
      return { label, contenders: [...c.contenders].sort((a, b) => b.votes - a.votes), abstain: c.abstain, lock: c.lock, total, outcome, height: 459_350 };
    },
    peek: () => undefined,
    forget: () => {},
  };
}
