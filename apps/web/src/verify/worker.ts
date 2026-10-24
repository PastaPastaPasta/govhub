/// <reference lib="webworker" />
// Verification worker: all hashing, signature recovery, DAPI fetches and the SML download run
// here so the page stays responsive.
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { fetchSml, fetchTransaction, resolveNodes } from '../data/dapi.ts';
import { makeBridge } from '../data/bridgeFactory.ts';
import { verifyCollateral } from './collateral.ts';
import type { DapiDescriptor, WorkerRequest, WorkerResponse } from './protocol.ts';
import { verifyVotes } from './votes.ts';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse) => self.postMessage(m);

async function nodesFor(d: DapiDescriptor): Promise<string[]> {
  if (d.kind === 'recorded') {
    await installRecordedDapi();
    return [RECORDED_NODE];
  }
  return resolveNodes(d.cfg, 8);
}

async function handle(req: WorkerRequest): Promise<void> {
  const progress = (message: string) => post({ id: req.id, kind: 'progress', message });
  if (req.kind === 'collateral') {
    progress('Finding DAPI nodes');
    let lookup: Parameters<typeof verifyCollateral>[1];
    try {
      const nodes = await nodesFor(req.dapi);
      progress('Fetching the collateral transaction');
      lookup = await fetchTransaction(nodes, req.proposal.collateralTxid);
    } catch (e) {
      const failures = (e as { failures?: Array<{ error: Error }> }).failures;
      lookup = { error: failures?.length ? failures.map((f) => f.error.message).slice(0, 3).join('; ') : (e as Error).message };
    }
    post({ id: req.id, kind: 'collateral', verdict: verifyCollateral(req.proposal, lookup) });
    return;
  }

  const bridge = makeBridge(req.bridge);
  progress(`Fetching signed votes and the masternode list from ${bridge.name}`);
  const [votes, mnlist] = await Promise.all([bridge.votes(req.govHash), bridge.mnlist()]);
  let sml: Awaited<ReturnType<typeof fetchSml>> | null = null;
  if (req.crossCheckSml && req.dapi.kind === 'live') {
    progress('Downloading the masternode list from DAPI (about 1.4 MB)');
    sml = await fetchSml(await nodesFor(req.dapi));
  }
  progress(`Checking ${votes.votes.length} signatures`);
  const result = verifyVotes({ govHash: req.govHash, votes: votes.votes, masternodes: mnlist.masternodes, network: req.network, now: req.now, expected: req.expected, sml: sml?.entries ?? null });
  post({ id: req.id, kind: 'votes', result, bridge: bridge.name, mnlistHeight: mnlist.height, votesAsOf: votes.asOfHeight, sml: sml ? { node: sml.node, validWeighted: sml.validWeighted } : null });
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  handle(ev.data).catch((e: unknown) => post({ id: ev.data.id, kind: 'error', message: e instanceof Error ? e.message : String(e) }));
};
