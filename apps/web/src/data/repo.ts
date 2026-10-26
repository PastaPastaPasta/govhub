// The data layer the UI talks to. Two implementations: live (Platform with proofs + bridge +
// DAPI) and fixtures (mainnet snapshot). Every value comes back with its provenance.
import { backendNotice, enabledBridges, registryScope, type Registry } from '../config/registry.ts';
import type { DataMode } from '../config/mode.ts';
import { shortHash, formatInt } from '../lib/format.ts';
import { GOV_PARAMS, type GovParams } from '../lib/governance.ts';
import { HttpBridge, type Bridge } from './bridge.ts';
import { cacheGet, cachePut } from './cache.ts';
import { createWebDapi, dapiConfig } from './dapi.ts';
import { loadFixtures } from './fixtures.ts';
import { docToCycle, docToProposal, docToTally, docToTallySet, govDocTypes, queryDocs } from './platform.ts';
import { activeProposals, latestCycles, pastProposals, proposalByHash, proposalsByName, talliesFor, tallySetPages, PAGE } from './queries.ts';
import type { BridgeDescriptor, DapiDescriptor } from '../verify/protocol.ts';
import type { DescStep } from '@govhub/forum';
import type { CoreNetwork, Cycle, Proposal, Provenance, Sourced, Tally } from './types.ts';

export interface Page {
  items: Sourced<Proposal>[];
  /** Opaque cursor for the next page, when there may be more (the Platform source's is a keyset cursor, see pastPage). */
  next?: string;
}

/** Optional "here is the cached value while the fresh read runs" callback. */
export type OnStale<T> = (cached: T) => void;

export interface DataSource {
  readonly mode: DataMode;
  readonly registry: Registry;
  /** The Core network the data belongs to (fixtures are a mainnet snapshot whatever the profile): addresses, votes and claims use it. */
  readonly coreNetwork: CoreNetwork;
  /** Everything cached for this source is keyed by this (profile, networks, contract). */
  readonly scope: string;
  /** Set when there is nothing to read (no `gov` contract for this profile yet); the source then reads nothing at all. */
  readonly notice: string | null;
  /** Chain parameters of `coreNetwork`, until `params()` answers. */
  readonly defaultParams: GovParams;
  /** Governance parameters of `coreNetwork`: its consensus constants (a bridge's getgovernanceinfo is not used). */
  params(): Promise<Sourced<GovParams>>;
  /** unix seconds; frozen in fixture mode */
  now(): number;
  cycle(onStale?: OnStale<Sourced<Cycle> | null>): Promise<Sourced<Cycle> | null>;
  active(onStale?: OnStale<Sourced<Proposal>[]>): Promise<Sourced<Proposal>[]>;
  pastPage(cursor?: string): Promise<Page>;
  proposal(govHash: string): Promise<Sourced<Proposal> | null>;
  byName(name: string): Promise<Sourced<Proposal>[]>;
  /**
   * Platform tallies (proof) for these proposals: the packed `talliesSet` entry (active proposals) or the per-proposal `tally`
   * document (ended proposals, and every tally on older testnet contracts), whichever is newer; the packed one on a tie.
   */
  tallies(govHashes: readonly string[]): Promise<Map<string, Sourced<Tally>>>;
  /** Live tallies from the first reachable bridge (reported). Empty without a bridge. */
  bridgeTallies(): Promise<Map<string, Sourced<Tally>>>;
  /** Core best height. */
  height(): Promise<Sourced<number> | null>;
  usdPrice(): Promise<Sourced<number> | null>;
  bridgeDescriptor(): BridgeDescriptor | null;
  dapiDescriptor(): DapiDescriptor;
}

// ---- fixtures -------------------------------------------------------------------------------
export function fixtureSource(registry: Registry): DataSource {
  const snap = loadFixtures();
  let now = 0;
  void snap.then((s) => (now = s.now));
  const wrap = <T>(value: T, detail = 'Core block 2,560,391, recorded 2026-10-23'): Sourced<T> => ({
    value,
    prov: { kind: 'fixture', source: 'mainnet snapshot', detail },
  });
  const proposals = async () => {
    const s = await snap;
    return [...s.proposals, ...s.invalid];
  };
  return {
    mode: 'fixtures',
    registry,
    coreNetwork: 'mainnet',
    scope: `fixtures:${registryScope(registry)}`,
    notice: null,
    defaultParams: GOV_PARAMS.mainnet,
    async params() {
      return wrap(GOV_PARAMS.mainnet, 'mainnet chain parameters');
    },
    now: () => now,
    async cycle() {
      return wrap((await snap).cycle, 'superblock budget from getsuperblockbudget; allocation computed like Core');
    },
    async active() {
      const s = await snap;
      return (await proposals()).filter((p) => p.endEpoch > s.now).map((p) => wrap(p));
    },
    async pastPage() {
      const s = await snap;
      return { items: s.proposals.filter((p) => p.endEpoch <= s.now).sort((a, b) => b.endEpoch - a.endEpoch).map((p) => wrap(p)) };
    },
    async proposal(h) {
      const p = (await proposals()).find((x) => x.govHash === h.toLowerCase());
      return p ? wrap(p) : null;
    },
    async byName(name) {
      return (await proposals()).filter((p) => p.name === name).map((p) => wrap(p));
    },
    async tallies(hashes) {
      const s = await snap;
      const out = new Map<string, Sourced<Tally>>();
      for (const h of hashes) {
        const t = s.tallies.get(h);
        if (!t) continue;
        out.set(h, wrap(t, s.recorded.proposals.has(h) ? `tally recorded from a mainnet bridge (block ${formatInt(t.asOfHeight)}); signed votes recorded` : 'vote counts from gobject list; voters synthetic'));
      }
      return out;
    },
    async bridgeTallies() {
      return new Map();
    },
    async height() {
      return wrap((await snap).height);
    },
    async usdPrice() {
      return null;
    },
    bridgeDescriptor: () => ({ kind: 'fixture' }),
    dapiDescriptor: () => ({ kind: 'recorded' }),
  };
}

// ---- live -----------------------------------------------------------------------------------
/** A value read from Platform with the Platform height it was proven at. */
interface Proven<T> {
  value: T;
  height: number | null;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The Past list's keyset cursor (see pastPage): the next step, and the ids already shown at its key. */
export interface PastCursor {
  step: Exclude<DescStep, { op: 'first' }>;
  ids: string[];
}

/** Parses a cursor pastPage made; null for anything else (pastPage then returns nothing rather than start over). */
export function parsePastCursor(cursor: string): PastCursor | null {
  try {
    const c = JSON.parse(cursor) as { step?: { op?: unknown; t?: unknown; startAfter?: unknown }; ids?: unknown };
    const s = c.step;
    if (!s || !['<=', '<', '=='].includes(s.op as string) || !Number.isSafeInteger(s.t)) return null;
    if (s.startAfter !== undefined && (s.op !== '==' || typeof s.startAfter !== 'string')) return null;
    if (!Array.isArray(c.ids) || !c.ids.every((x) => typeof x === 'string')) return null;
    return { step: s as PastCursor['step'], ids: c.ids as string[] };
  } catch {
    return null;
  }
}

const chainParams = (network: CoreNetwork, detail?: string): Sourced<GovParams> => ({
  value: GOV_PARAMS[network],
  prov: { kind: 'reported', source: `Dash Core ${network} chain parameters`, ...(detail ? { detail } : {}) },
});

export function liveSource(registry: Registry): DataSource {
  const notice = backendNotice(registry);
  if (notice) return emptySource(registry, notice);
  const contract = shortHash(registry.govContractId, 4);
  const proof = (height: number | null, extra?: string): Provenance => ({
    kind: 'proof',
    source: `Platform ${registry.platformNetwork}`,
    detail: [`gov contract ${contract}`, height ? `Platform height ${formatInt(height)}` : null, extra].filter(Boolean).join(', '),
  });
  /** One keyset step of the Past list (see pastPage): the new items and the cursor of the next step, if any. */
  const pastStep = async (at: PastCursor): Promise<{ items: Sourced<Proposal>[]; next?: PastCursor }> => {
    const r = await queryDocs(registry, pastProposals(at.step));
    const shown = new Set(at.ids);
    const all = r.docs.map(docToProposal);
    const items = all.filter((p) => !p.docId || !shown.has(p.docId)).map((p) => ({ value: p, prov: proof(r.height) }));
    const full = r.docs.length >= PAGE;
    const first = all[0];
    const last = all.at(-1);
    const { step } = at;
    if (step.op === '==') {
      if (full && last?.docId) return { items, next: { step: { op: '==', t: step.t, startAfter: last.docId }, ids: at.ids } };
      return { items, next: { step: { op: '<', t: step.t }, ids: [] } };
    }
    if (!full || !first || !last) return { items };
    const idsAt = (t: number) => all.flatMap((p) => (p.endEpoch === t && p.docId ? [p.docId] : []));
    const carried = step.op === '<=' && step.t === last.endEpoch ? at.ids : [];
    if (first.endEpoch === last.endEpoch) return { items, next: { step: { op: '==', t: last.endEpoch }, ids: [...new Set([...carried, ...idsAt(last.endEpoch)])] } };
    return { items, next: { step: { op: '<=', t: last.endEpoch }, ids: idsAt(last.endEpoch) } };
  };
  const bridges: Bridge[] = enabledBridges(registry).map((b) => new HttpBridge(b.name, b.httpBase));
  const scope = registryScope(registry);
  const cacheKey = (k: string) => `${scope}:${k}`;
  const defaultParams = GOV_PARAMS[registry.coreNetwork];

  /** Proven read with an IndexedDB copy: `onStale` gets the cached value (and its age) first. */
  async function cached<T>(key: string, onStale: ((v: T, note: string) => void) | undefined, run: () => Promise<Proven<T>>): Promise<Proven<T>> {
    let fresh = false;
    if (onStale) {
      void cacheGet<T>(cacheKey(key)).then((c) => {
        if (c && !fresh) onStale(c.value, `cached ${Math.max(1, Math.round((Date.now() - c.savedAt) / 60000))} min ago at Platform height ${c.height ?? '?'}`);
      });
    }
    const r = await run();
    fresh = true;
    void cachePut(cacheKey(key), r.value, r.height);
    return r;
  }

  // A bridge is only asked once its status says it runs on this Core network and publishes into this contract: a bridge for another
  // network would answer with that network's proposals and cycle, which must never be shown under this profile.
  const coherent = new Map<Bridge, Promise<boolean>>();
  const isCoherent = (b: Bridge): Promise<boolean> => {
    let p = coherent.get(b);
    if (!p) {
      p = b.status().then((st) => st.network === registry.coreNetwork && (!st.govContractId || st.govContractId === registry.govContractId));
      coherent.set(b, p);
      p.catch(() => coherent.delete(b)); // unreachable: ask again next time
    }
    return p.catch(() => false);
  };

  /** The first bridge whose status checked out: the one the verification worker is pointed at. */
  let coherentIndex: number | null = null;

  /** First coherent bridge that answers. */
  async function firstBridge<T>(fn: (b: Bridge) => Promise<T>): Promise<{ value: T; bridge: Bridge } | null> {
    for (const [i, b] of bridges.entries()) {
      if (!(await isCoherent(b))) continue;
      coherentIndex ??= i;
      try {
        return { value: await fn(b), bridge: b };
      } catch {
        /* try the next one */
      }
    }
    return null;
  }

  const reported = (b: Bridge, detail?: string): Provenance => ({ kind: 'reported', source: b.name, ...(detail ? { detail } : {}) });
  // The page only asks DAPI for the best height. Verification (X11, BLS) runs in the worker's own client.
  let dapi: ReturnType<typeof createWebDapi> | null = null;

  return {
    mode: 'live',
    registry,
    coreNetwork: registry.coreNetwork,
    scope,
    notice: null,
    defaultParams,
    now: nowSeconds,

    // Consensus constants of the profile's Core network (chainparams.cpp), never a bridge's getgovernanceinfo: a lying bridge must not
    // set the superblock cycle, maturity window or minimum quorum the page computes thresholds and schedules with.
    async params() {
      return chainParams(registry.coreNetwork, 'consensus constants (chainparams.cpp), not a bridge report');
    },

    async cycle(onStale) {
      try {
        const c = await cached<Cycle | null>(
          'cycle',
          onStale && ((v, note) => onStale(v ? { value: v, prov: proof(null, note) } : null)),
          async () => {
            const r = await queryDocs(registry, latestCycles(1));
            return { value: r.docs[0] ? docToCycle(r.docs[0]) : null, height: r.height };
          },
        );
        if (c.value) return { value: c.value, prov: proof(c.height) };
      } catch {
        /* fall through to the bridge */
      }
      const b = await firstBridge((x) => x.cycle());
      return b?.value ? { value: b.value, prov: reported(b.bridge) } : null;
    },

    async active(onStale) {
      const now = nowSeconds();
      let platformError: unknown = null;
      const { value: fromPlatform, height } = await cached<Proposal[]>(
        'active',
        onStale && ((v, note) => onStale(v.map((p) => ({ value: p, prov: proof(null, note) })))),
        async () => {
          const all: Proposal[] = [];
          let h: number | null = null;
          let cursor: string | undefined;
          for (let i = 0; i < 10; i++) {
            const r = await queryDocs(registry, activeProposals(now, cursor));
            h = r.height ?? h;
            all.push(...r.docs.map(docToProposal));
            if (r.docs.length < PAGE) break;
            cursor = all.at(-1)?.docId;
          }
          return { value: all, height: h };
        },
      ).catch((e: unknown) => {
        platformError = e;
        return { value: [] as Proposal[], height: null };
      });
      const out: Sourced<Proposal>[] = fromPlatform.map((p) => ({ value: p, prov: proof(height) }));
      // Proposals the bridge knows but has not published yet: shown, clearly marked as reported.
      const seen = new Set(fromPlatform.map((p) => p.govHash));
      const b = await firstBridge((x) => x.proposals());
      for (const p of b?.value ?? []) if (p.endEpoch > now && !seen.has(p.govHash)) out.push({ value: p, prov: reported(b!.bridge, platformError ? 'Platform could not be read' : 'not yet published on Platform') });
      if (platformError && !b) throw platformError;
      return out;
    },

    async pastPage(cursor) {
      // Keyset paging (R8: a desc query cannot carry startAfter on PV13). The cursor is the next step plus the ids already shown at its key:
      // `endEpoch <= t` re-reads the proposals ending at t and skips those; when a whole page shares one end, that end is swept ascending
      // (`== t`, startAfter) and the list goes on below it (`< t`). Nothing is lost or repeated, however many proposals share an end.
      let at: PastCursor | null = cursor ? parsePastCursor(cursor) : { step: { op: '<=', t: nowSeconds() }, ids: [] };
      // A sweep page can hold only proposals already shown; keep stepping (each step moves on) so a page with a cursor always has
      // items: the Past page loads the next one only when its rows grow.
      for (let guard = 0; at && guard < 50; guard++) {
        const r = await pastStep(at);
        if (r.items.length || !r.next) return r.next ? { items: r.items, next: JSON.stringify(r.next) } : { items: r.items };
        at = r.next;
      }
      return { items: [] };
    },

    async proposal(h) {
      const r = await queryDocs(registry, proposalByHash(h));
      if (r.docs[0]) return { value: docToProposal(r.docs[0]), prov: proof(r.height) };
      const b = await firstBridge((x) => x.proposal(h));
      return b?.value ? { value: b.value, prov: reported(b.bridge, 'not yet published on Platform') } : null;
    },

    async byName(name) {
      const r = await queryDocs(registry, proposalsByName(name));
      return r.docs.map((d) => ({ value: docToProposal(d), prov: proof(r.height) }));
    },

    async tallies(hashes) {
      const want = new Set(hashes.map((h) => h.toLowerCase()));
      if (!want.size) return new Map();
      const uniq = [...want];
      const packed = async (): Promise<Sourced<Tally>[]> => {
        if (!(await govDocTypes(registry)).has('talliesSet')) return [];
        const r = await queryDocs(registry, tallySetPages());
        return r.docs.flatMap((d) => {
          try {
            const set = docToTallySet(d);
            const prov = proof(r.height, `tally as of Core block ${formatInt(set.asOfHeight)}, packed tally set page ${set.page}`);
            return set.tallies.map((t) => ({ value: t, prov }));
          } catch (e) {
            // a page that does not decode carries no tally at all: its proposals read as "no tally published"
            console.warn('talliesSet page does not decode', e);
            return [];
          }
        });
      };
      const single = async (): Promise<Sourced<Tally>[]> => {
        const found: Sourced<Tally>[] = [];
        for (let i = 0; i < uniq.length; i += PAGE) {
          const r = await queryDocs(registry, talliesFor(uniq.slice(i, i + PAGE)));
          for (const t of r.docs.map(docToTally)) found.push({ value: t, prov: proof(r.height, `tally as of Core block ${formatInt(t.asOfHeight)}`) });
        }
        return found;
      };
      // A failed talliesSet read must not take the per-proposal tallies with it: those proposals then read as "no tally published".
      const packedOrNone = packed().catch((e: unknown) => {
        console.warn('talliesSet pages could not be read', e);
        return [] as Sourced<Tally>[];
      });
      const [fromSet, fromDocs] = await Promise.all([packedOrNone, single()]);
      const out = new Map<string, Sourced<Tally>>();
      // On a tie the packed entry wins, except over a proposal's final tally (rank 0, not in the next budget): the bridge writes that
      // when the proposal leaves the active set, possibly before its next (throttled) replace of the set drops the entry.
      const final = (t: Tally) => t.rank === 0 && !t.inNextBudget;
      for (const t of [...fromSet, ...fromDocs]) {
        const cur = out.get(t.value.govHash);
        if (!want.has(t.value.govHash)) continue;
        if (!cur || t.value.asOfHeight > cur.value.asOfHeight || (t.value.asOfHeight === cur.value.asOfHeight && final(t.value) && !final(cur.value))) out.set(t.value.govHash, t);
      }
      return out;
    },

    async bridgeTallies() {
      const b = await firstBridge((x) => x.tallies());
      return new Map((b?.value ?? []).map((t) => [t.govHash, { value: t, prov: reported(b!.bridge, `live tally as of Core block ${formatInt(t.asOfHeight)}`) }]));
    },

    async height() {
      try {
        dapi ??= createWebDapi(dapiConfig(registry));
        const h = await dapi.getBestBlockHeight();
        return { value: h.height, prov: { kind: 'reported', source: `DAPI ${registry.coreNetwork}`, detail: `best height from ${h.node}, a node that reports itself synced` } };
      } catch {
        const b = await firstBridge((x) => x.status());
        return b ? { value: b.value.height, prov: reported(b.bridge) } : null;
      }
    },

    async usdPrice() {
      const pf = registry.priceFeed;
      // testnet DASH has no price: a USD figure next to a testnet budget would be made up
      if (!pf?.url || registry.coreNetwork === 'testnet') return null;
      try {
        const res = await fetch(pf.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
        const j = (await res.json()) as { dash?: { usd?: unknown } };
        const usd = j.dash?.usd;
        return typeof usd === 'number' && usd > 0 ? { value: usd, prov: { kind: 'reported', source: pf.name } } : null;
      } catch {
        return null;
      }
    },

    bridgeDescriptor() {
      // The worker asks a bridge for votes and the MN list directly: the one whose status matched, once one has.
      const b = enabledBridges(registry)[coherentIndex ?? 0];
      return b ? { kind: 'http', name: b.name, base: b.httpBase } : null;
    },
    dapiDescriptor: () => ({ kind: 'live', cfg: dapiConfig(registry) }),
  };
}

/** A profile with no `gov` contract yet: nothing is read, from Platform, a bridge or DAPI. */
function emptySource(registry: Registry, notice: string): DataSource {
  const defaultParams = GOV_PARAMS[registry.coreNetwork];
  return {
    mode: 'live',
    registry,
    coreNetwork: registry.coreNetwork,
    scope: registryScope(registry),
    notice,
    defaultParams,
    params: async () => chainParams(registry.coreNetwork),
    now: nowSeconds,
    cycle: async () => null,
    active: async () => [],
    pastPage: async () => ({ items: [] }),
    proposal: async () => null,
    byName: async () => [],
    tallies: async () => new Map(),
    bridgeTallies: async () => new Map(),
    height: async () => null,
    usdPrice: async () => null,
    bridgeDescriptor: () => null,
    dapiDescriptor: () => ({ kind: 'live', cfg: dapiConfig(registry) }),
  };
}

export const createSource = (mode: DataMode, registry: Registry): DataSource => (mode === 'fixtures' ? fixtureSource(registry) : liveSource(registry));
