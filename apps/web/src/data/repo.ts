// The data layer the UI talks to. Two implementations: live (Platform with proofs + bridge +
// DAPI) and fixtures (mainnet snapshot). Every value comes back with its provenance.
import { enabledBridges, type Registry } from '../config/registry.ts';
import type { DataMode } from '../config/mode.ts';
import { shortHash, formatInt } from '../lib/format.ts';
import { HttpBridge, type Bridge } from './bridge.ts';
import { cacheGet, cachePut } from './cache.ts';
import { createWebDapi, dapiConfig } from './dapi.ts';
import { loadFixtures } from './fixtures.ts';
import { docToCycle, docToProposal, docToTally, queryDocs } from './platform.ts';
import { activeProposals, latestCycles, pastProposals, proposalByHash, proposalsByName, talliesFor, PAGE } from './queries.ts';
import type { BridgeDescriptor, DapiDescriptor } from '../verify/protocol.ts';
import type { Cycle, Proposal, Provenance, Sourced, Tally } from './types.ts';

export interface Page {
  items: Sourced<Proposal>[];
  /** Cursor (last document id) for the next page, when there may be more. */
  next?: string;
}

/** Optional "here is the cached value while the fresh read runs" callback. */
export type OnStale<T> = (cached: T) => void;

export interface DataSource {
  readonly mode: DataMode;
  readonly registry: Registry;
  /** unix seconds; frozen in fixture mode */
  now(): number;
  cycle(onStale?: OnStale<Sourced<Cycle> | null>): Promise<Sourced<Cycle> | null>;
  active(onStale?: OnStale<Sourced<Proposal>[]>): Promise<Sourced<Proposal>[]>;
  pastPage(cursor?: string): Promise<Page>;
  proposal(govHash: string): Promise<Sourced<Proposal> | null>;
  byName(name: string): Promise<Sourced<Proposal>[]>;
  /** Platform tallies (proof) for these proposals. */
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
  return {
    mode: 'fixtures',
    registry,
    now: () => now,
    async cycle() {
      return wrap((await snap).cycle, 'superblock budget from getsuperblockbudget; allocation computed like Core');
    },
    async active() {
      const s = await snap;
      return s.proposals.filter((p) => p.endEpoch > s.now).map((p) => wrap(p));
    },
    async pastPage() {
      const s = await snap;
      return { items: s.proposals.filter((p) => p.endEpoch <= s.now).sort((a, b) => b.endEpoch - a.endEpoch).map((p) => wrap(p)) };
    },
    async proposal(h) {
      const p = (await snap).proposals.find((x) => x.govHash === h.toLowerCase());
      return p ? wrap(p) : null;
    },
    async byName(name) {
      return (await snap).proposals.filter((p) => p.name === name).map((p) => wrap(p));
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

export function liveSource(registry: Registry): DataSource {
  const contract = shortHash(registry.govContractId, 4);
  const proof = (height: number | null, extra?: string): Provenance => ({
    kind: 'proof',
    source: `Platform ${registry.platformNetwork}`,
    detail: [`gov contract ${contract}`, height ? `Platform height ${formatInt(height)}` : null, extra].filter(Boolean).join(', '),
  });
  const bridges: Bridge[] = enabledBridges(registry).map((b) => new HttpBridge(b.name, b.httpBase));
  const cacheKey = (k: string) => `${registry.platformNetwork}:${registry.govContractId}:${k}`;

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

  /** First bridge that answers. */
  async function firstBridge<T>(fn: (b: Bridge) => Promise<T>): Promise<{ value: T; bridge: Bridge } | null> {
    for (const b of bridges) {
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
    now: nowSeconds,

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
      const r = await queryDocs(registry, pastProposals(nowSeconds(), cursor));
      const items = r.docs.map((d) => ({ value: docToProposal(d), prov: proof(r.height) }));
      const next = r.docs.length === PAGE ? items.at(-1)?.value.docId : undefined;
      return next ? { items, next } : { items };
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
      const out = new Map<string, Sourced<Tally>>();
      const uniq = [...new Set(hashes)];
      for (let i = 0; i < uniq.length; i += PAGE) {
        const r = await queryDocs(registry, talliesFor(uniq.slice(i, i + PAGE)));
        for (const d of r.docs) {
          const t = docToTally(d);
          out.set(t.govHash, { value: t, prov: proof(r.height, `tally as of Core block ${formatInt(t.asOfHeight)}`) });
        }
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
      if (!pf?.url) return null;
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
      const b = enabledBridges(registry)[0];
      return b ? { kind: 'http', name: b.name, base: b.httpBase } : null;
    },
    dapiDescriptor: () => ({ kind: 'live', cfg: dapiConfig(registry) }),
  };
}

export const createSource = (mode: DataMode, registry: Registry): DataSource => (mode === 'fixtures' ? fixtureSource(registry) : liveSource(registry));
