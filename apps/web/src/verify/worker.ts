/// <reference lib="webworker" />
// Verification worker: all hashing, signature recovery, DAPI fetches, the ChainLock proof and the SML
// download run here so the page stays responsive.
import { AllNodesFailedError, createDapi, GrpcError, type Dapi } from '@govhub/dapi';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { createWebDapi, lookupCollateral } from '../data/dapi.ts';
import { BridgeError, type BridgeVotes } from '../data/bridge.ts';
import { makeBridge } from '../data/bridgeFactory.ts';
import { verifyCollateral } from './collateral.ts';
import type { DapiDescriptor, WorkerRequest, WorkerResponse } from './protocol.ts';
import { loadVerifiers } from './verifiers.ts';
import { verifyVotes, type SmlEntry, type VoteRun, type VoteTarget } from './votes.ts';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse) => self.postMessage(m);

/** One client per DAPI setting: the SML fetched for the ChainLock proof is reused by the vote check (5 min cache). */
const clients = new Map<string, Dapi>();

async function dapiFor(d: DapiDescriptor): Promise<Dapi> {
  const key = d.kind === 'recorded' ? 'recorded' : JSON.stringify(d.cfg);
  let c = clients.get(key);
  if (!c) {
    if (d.kind === 'recorded') {
      await installRecordedDapi();
      c = createDapi({ network: 'mainnet', nodes: [RECORDED_NODE] });
    } else {
      c = createWebDapi(d.cfg, loadVerifiers);
    }
    clients.set(key, c);
  }
  return c;
}

/** Targets grouped by the Core height their tally is as of: each group is recounted from the vote set behind that height. */
function byHeight(targets: readonly VoteTarget[]): Array<{ height: number | null; targets: VoteTarget[] }> {
  if (targets.length === 0) return [{ height: null, targets: [] }];
  const groups = new Map<number, VoteTarget[]>();
  for (const t of targets) groups.set(t.tally.asOfHeight, [...(groups.get(t.tally.asOfHeight) ?? []), t]);
  return [...groups].map(([height, ts]) => ({ height, targets: ts }));
}

const NOT_FOUND = 5;
/**
 * The transaction is not on that chain: at least two distinct nodes answered NOT_FOUND (Dapi.call throws the second one), or the
 * recorded replay (a recording, not a node that could lag) did. One live node's NOT_FOUND is inconclusive.
 */
function isNotFound(e: unknown, recorded: boolean): boolean {
  if (e instanceof GrpcError && e.code === NOT_FOUND) return true;
  if (!(e instanceof AllNodesFailedError)) return false;
  const nf = new Set(e.errors.filter((x) => x.error instanceof GrpcError && x.error.code === NOT_FOUND).map((x) => x.node));
  return nf.size === e.errors.length && nf.size >= (recorded ? 1 : 2);
}

async function handle(req: WorkerRequest): Promise<void> {
  const progress = (message: string) => post({ id: req.id, kind: 'progress', message });
  if (req.kind === 'collateral') {
    progress('Finding DAPI nodes');
    let lookup: Parameters<typeof verifyCollateral>[1];
    try {
      const dapi = await dapiFor(req.dapi);
      const verify = req.dapi.kind === 'live' && !req.light;
      progress(verify ? 'Fetching the collateral transaction and proving it into a block' : 'Fetching the collateral transaction');
      lookup = await lookupCollateral(dapi, req.proposal.collateralTxid, { verify, onProgress: progress });
    } catch (e) {
      lookup = { error: (e as Error).message, ...(isNotFound(e, req.dapi.kind === 'recorded') ? { notFound: true } : {}) };
    }
    post({ id: req.id, kind: 'collateral', verdict: verifyCollateral(req.proposal, lookup) });
    return;
  }

  const bridge = makeBridge(req.bridge);
  let sml: { entries: Map<string, SmlEntry>; nodes: string[]; height: number | null; validWeighted: number } | null = null;
  if (req.crossCheckSml && req.dapi.kind === 'live') {
    progress('Getting the masternode list from several DAPI nodes and comparing it (about 1.4 MB each)');
    const agreed = await (await dapiFor(req.dapi)).getSml();
    sml = {
      entries: new Map(agreed.masternodes.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: m.isValid, nType: m.nType }])),
      nodes: agreed.agreedBy,
      height: agreed.height,
      validWeighted: agreed.masternodes.reduce((n, m) => n + (m.isValid ? (m.nType === 1 ? 4 : 1) : 0), 0),
    };
  }

  const runs: VoteRun[] = [];
  let origin: BridgeVotes['origin'];
  for (const g of byHeight(req.targets)) {
    const names = g.targets.map((t) => t.name).join(' and ') || 'the live tally';
    progress(`Fetching the signed votes behind the ${names}${g.height ? ` (block ${g.height.toLocaleString('en-US')})` : ''} from ${bridge.name}`);
    let votes: BridgeVotes;
    try {
      votes = await bridge.votes(req.govHash, g.height === null ? {} : { height: g.height });
    } catch (e) {
      // A bridge that no longer holds the set for that height (404) still serves its live set; the verdict then says "different height".
      // Anything else (unreachable, HTTP 500, malformed JSON) is a failure, not a reason to compare something else.
      if (g.height === null || !(e instanceof BridgeError) || e.status !== 404) throw e;
      votes = await bridge.votes(req.govHash);
    }
    origin = votes.origin ?? origin;
    progress(`Fetching the masternode list at block ${votes.tallyHeight.toLocaleString('en-US')}`);
    const mnlist = await bridge.mnlist(votes.tallyHeight);
    progress(`Checking ${votes.votes.length} signatures`);
    const result = verifyVotes({ govHash: req.govHash, votes: votes.votes, masternodes: mnlist.masternodes, network: req.network, now: req.now, targets: g.targets, sml: sml?.entries ?? null });
    // votesAsOf is the height of the tally whose set was actually served (<= the requested height), not the height echoed back.
    runs.push({ result, votesAsOf: votes.tallyHeight, mnlistHeight: mnlist.height, listMatches: votes.mnListHash && mnlist.listHash ? votes.mnListHash === mnlist.listHash : null });
  }
  post({ id: req.id, kind: 'votes', bridge: bridge.name, runs, ...(origin ? { origin } : {}), sml: sml ? { nodes: sml.nodes, height: sml.height, validWeighted: sml.validWeighted } : null });
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  handle(ev.data).catch((e: unknown) => post({ id: ev.data.id, kind: 'error', message: e instanceof Error ? e.message : String(e) }));
};
