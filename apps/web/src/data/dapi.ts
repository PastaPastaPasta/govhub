// Thin adapter over the grpc-web DAPI client. Today it imports the phase-0 spike; when
// packages/dapi (@govhub/dapi) lands, change the import below and nothing else in the app.
import { DapiCore, fetchNodes, race, sample, parseMasternodeListDiff } from '../../../../spikes/dapi-browser/src/index.js';
import type { Registry } from '../config/registry.ts';
import type { TxLookup } from '../verify/collateral.ts';
import type { SmlEntry } from '../verify/votes.ts';

export interface DapiConfig {
  source: Registry['dapi']['source'];
  quorumUrl: string;
  nodes: string[];
}

export const dapiConfig = (r: Registry): DapiConfig => ({ source: r.dapi.source, quorumUrl: r.dapi.quorumUrl, nodes: r.dapi.nodes });

/** Candidate evonodes (host:port): the manual list, or a random sample from the quorum service. */
export async function resolveNodes(cfg: DapiConfig, k = 8): Promise<string[]> {
  if (cfg.source === 'manual') return sample(cfg.nodes, Math.min(k, cfg.nodes.length));
  return sample(await fetchNodes(cfg.quorumUrl), k);
}

/** getTransaction raced over two nodes at a time; the first node that answers wins. */
export async function fetchTransaction(nodes: string[], txid: string): Promise<TxLookup> {
  const r = await race(nodes, (node: string, signal: AbortSignal) => new DapiCore(node).getTransaction(txid, { signal }), { n: 2 });
  const v = r.value as { raw: Uint8Array; height: number; confirmations: number; isChainLocked: boolean; isInstantLocked: boolean };
  return { raw: v.raw, height: v.height, confirmations: v.confirmations, isChainLocked: v.isChainLocked, isInstantLocked: v.isInstantLocked, node: r.node };
}

/** Best block height; requires two nodes to agree within one block. */
export async function fetchBestHeight(nodes: string[]): Promise<{ height: number; node: string }> {
  const first = await race(nodes, (node: string, signal: AbortSignal) => new DapiCore(node, { timeoutMs: 8000 }).getBestBlockHeight({ signal }), { n: 2 });
  const rest = nodes.filter((n) => n !== first.node);
  try {
    const second = await race(rest, (node: string, signal: AbortSignal) => new DapiCore(node, { timeoutMs: 8000 }).getBestBlockHeight({ signal }), { n: 2 });
    if (Math.abs((second.value as number) - (first.value as number)) > 1) throw new Error(`DAPI nodes disagree on the tip: ${first.value} vs ${second.value}`);
  } catch (e) {
    if ((e as Error).message.startsWith('DAPI nodes disagree')) throw e;
    // Only one node reachable: use it, the caller labels the value node-reported anyway.
  }
  return { height: first.value as number, node: first.node };
}

interface SmlSnapshot {
  entries: Map<string, SmlEntry>;
  validWeighted: number;
  node: string;
  blockHash: string;
  merkleRoot: string;
}

/** The full SML from one node: the first message of subscribeToMasternodeList (~1.4 MB on mainnet). */
async function fetchSmlOnce(nodes: string[]): Promise<SmlSnapshot> {
  const r = await race(
    nodes,
    (node: string, signal: AbortSignal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const h = new DapiCore(node, { timeoutMs: 30000 }).subscribeToMasternodeList(
          (bytes: Uint8Array) => {
            resolve(bytes);
            h.cancel();
          },
          { signal },
        );
        h.closed.then((c: { reason: string; error?: unknown }) => reject(c.error instanceof Error ? c.error : new Error(`stream ${c.reason}`)));
      }),
    { n: 2 },
  );
  const parsed = parseMasternodeListDiff(r.value as Uint8Array);
  const entries = new Map<string, SmlEntry>();
  let validWeighted = 0;
  for (const m of parsed.diff.mnList as Array<{ proRegTxHash: string; votingAddress: string; isValid: boolean; nType: number }>) {
    entries.set(m.proRegTxHash.toLowerCase(), { votingAddress: m.votingAddress, isValid: m.isValid, nType: m.nType });
    if (m.isValid) validWeighted += m.nType === 1 ? 4 : 1;
  }
  return { entries, validWeighted, node: r.node, blockHash: parsed.blockHash as string, merkleRoot: parsed.merkleRootMNList as string };
}

/**
 * The SML as two different nodes agree on it (same merkleRootMNList), PLAN §2. Tries up to three
 * nodes, since two honest nodes can be a block apart.
 */
export async function fetchSml(nodes: string[]): Promise<SmlSnapshot & { agreeing: string[] }> {
  const got: SmlSnapshot[] = [];
  const used = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const s = await fetchSmlOnce(nodes.filter((n) => !used.has(n)));
    used.add(s.node);
    const twin = got.find((g) => g.merkleRoot === s.merkleRoot);
    if (twin) return { ...s, agreeing: [twin.node, s.node] };
    got.push(s);
  }
  throw new Error('DAPI nodes disagree on the masternode list (no two of three share a merkleRootMNList)');
}
