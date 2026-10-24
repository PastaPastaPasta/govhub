/// <reference lib="webworker" />
// Verification worker: all hashing, signature recovery, DAPI fetches, the anchored chain (headers, masternode list, ChainLock)
// and the vote recounts run here so the page stays responsive.
import { AllNodesFailedError, createDapi, GrpcError, type AnchoredChain, type Dapi } from '@govhub/dapi';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { createWebDapi, lookupCollateral } from '../data/dapi.ts';
import { BridgeError, type Bridge, type BridgeMnList, type BridgeVotes } from '../data/bridge.ts';
import { makeBridge } from '../data/bridgeFactory.ts';
import type { CoreNetwork } from '../data/types.ts';
import { claimedWeight, payments, scheduleAndBudget, summarize, threshold, EST_BLOCK_SECONDS } from './chain.ts';
import { verifyCollateral } from './collateral.ts';
import type { DapiDescriptor, SmlUsed, WorkerRequest, WorkerResponse } from './protocol.ts';
import { rankRecounts, type RecountedProposal } from './ranking.ts';
import { BRIDGE_TARGET } from './verdict.ts';
import { headerStore, proRegCache } from './stores.ts';
import { loadVerifiers } from './verifiers.ts';
import { verifyVotes, type ProReg, type SmlEntry, type VoteRun, type VoteTarget } from './votes.ts';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse) => self.postMessage(m);

/** One client per DAPI setting: the anchored chain (and its proven SML) is reused by every check for a minute. */
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

/** The chain this worker verified (cached in IndexedDB per network, extended on each use), reaching down to `from`. */
function anchor(dapi: Dapi, progress: (m: string) => void, from?: number): Promise<AnchoredChain> {
  return dapi.anchorChain({ ...(from ? { from } : {}), store: headerStore('chain'), onProgress: progress });
}

/** The proven list as the vote check uses it (types count as proven only where the list's hash covers them). */
function smlEntries(a: AnchoredChain): { entries: Map<string, SmlEntry>; used: SmlUsed } {
  const entries = new Map(a.sml.masternodes.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: m.isValid, nType: m.nType, typeProven: m.nVersion >= 2 }]));
  return { entries, used: { height: a.sml.proof.height, blockHash: a.sml.proof.blockHash, node: a.sml.node, validWeighted: claimedWeight(a.sml.masternodes), weak: a.weak } };
}

/** ProRegTx facts for the masternodes behind these votes (the bridge's outpoint -> proTxHash mapping is what they check). */
async function proRegFor(dapi: Dapi, network: CoreNetwork, votes: BridgeVotes, list: BridgeMnList, progress: (m: string) => void): Promise<Map<string, ProReg>> {
  const byOutpoint = new Map(list.masternodes.map((m) => [`${m.collateralTxid.toLowerCase()}-${m.collateralIndex}`, m.proTxHash.toLowerCase()]));
  const hashes = [...new Set(votes.votes.map((v) => byOutpoint.get(`${v.collateralTxid.toLowerCase()}-${v.collateralIndex}`)).filter((h): h is string => !!h))];
  return dapi.getProRegInfo(hashes, {
    cache: proRegCache(network),
    onProgress: (done, total) => { if (done === 1 || done % 50 === 0 || done === total) progress(`Checking ${total.toLocaleString('en-US')} masternode registrations (${done.toLocaleString('en-US')} done; cached afterwards)`); },
  });
}

async function handle(req: WorkerRequest): Promise<void> {
  const progress = (message: string) => post({ id: req.id, kind: 'progress', message });
  if (req.kind === 'collateral') {
    progress('Finding DAPI nodes');
    let lookup: Parameters<typeof verifyCollateral>[1];
    let anchorError: string | null = null;
    try {
      const dapi = await dapiFor(req.dapi);
      const verify = req.dapi.kind === 'live' && !req.light;
      let a: AnchoredChain | undefined;
      if (verify) {
        // The verified chain down to the collateral's block: cached headers are reused, only the missing ones are fetched.
        // The published height only sizes the first download; if it is unusable (too deep, a lie) anchor without it, and the
        // merkle-proven height decides below.
        for (const from of [req.proposal.collateralHeight || undefined, undefined]) {
          try {
            a = await anchor(dapi, progress, from);
            break;
          } catch (e) {
            anchorError = (e as Error).message;
            if (from === undefined) progress('The chain could not be verified; falling back to the block and ChainLock proof');
          }
        }
        if (a) anchorError = null;
      }
      progress(verify ? 'Fetching the collateral transaction and proving it into a block' : 'Fetching the collateral transaction');
      lookup = await lookupCollateral(dapi, req.proposal.collateralTxid, { verify, onProgress: progress, ...(a ? { anchor: a } : {}) });
      // the published height was too high (or missing): anchor down to the real block and look again
      if (a && !lookup.proof.anchor && lookup.proof.merkle && lookup.height > 0 && lookup.height < a.chain.lo) {
        try {
          a = await anchor(dapi, progress, lookup.height);
          lookup = await lookupCollateral(dapi, req.proposal.collateralTxid, { verify, onProgress: progress, anchor: a });
        } catch (e) {
          anchorError = (e as Error).message; // keep the first lookup (its own ChainLock proof, or the node's word)
        }
      }
    } catch (e) {
      lookup = { error: (e as Error).message, ...(isNotFound(e, req.dapi.kind === 'recorded') ? { notFound: true } : {}) };
    }
    const verdict = verifyCollateral(req.proposal, lookup);
    if (anchorError) verdict.anchorError = anchorError;
    post({ id: req.id, kind: 'collateral', verdict });
    return;
  }

  if (req.kind === 'chain') {
    if (req.dapi.kind !== 'live') throw new Error('chain facts need live DAPI nodes (recorded data has no header chain)');
    const dapi = await dapiFor(req.dapi);
    const a = await anchor(dapi, progress, req.from || undefined);
    progress('Computing the funding threshold from the proven masternode list');
    const th = await threshold(dapi, a, req.network, proRegCache(req.network), progress);
    progress('Reading superblock coinbases for this proposal\'s payments');
    const pay = req.from ? { ...(await payments(dapi, a, req.proposal, req.others, req.network, req.from, req.now)), othersComplete: req.othersComplete } : null;
    post({ id: req.id, kind: 'chain', report: { network: req.network, anchor: summarize(a), ...scheduleAndBudget(a, req.network, req.now), threshold: th, payments: pay } });
    return;
  }

  const bridge = makeBridge(req.bridge);
  if (req.kind === 'ranking') {
    post({ id: req.id, kind: 'ranking', result: await ranking(req, bridge, progress) });
    return;
  }

  let sml: ReturnType<typeof smlEntries> | null = null;
  let dapi: Dapi | null = null;
  if (req.crossCheckSml && req.dapi.kind === 'live') {
    progress('Verifying the chain and the masternode list (cached after the first time)');
    dapi = await dapiFor(req.dapi);
    sml = smlEntries(await anchor(dapi, progress));
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
    const proReg = dapi ? await proRegFor(dapi, req.network, votes, mnlist, progress) : null;
    progress(`Checking ${votes.votes.length} signatures`);
    const result = verifyVotes({ govHash: req.govHash, votes: votes.votes, masternodes: mnlist.masternodes, network: req.network, now: req.now, targets: g.targets, sml: sml?.entries ?? null, proReg });
    // keys checked against a list on a chain proof of work does not protect (testnet): a match is not "verified"
    if (sml?.used.weak) result.keysFrom = 'bridge';
    // votesAsOf is the height of the tally whose set was actually served (<= the requested height), not the height echoed back.
    runs.push({ result, votesAsOf: votes.tallyHeight, mnlistHeight: mnlist.height, listMatches: votes.mnListHash && mnlist.listHash ? votes.mnListHash === mnlist.listHash : null });
  }
  post({ id: req.id, kind: 'votes', bridge: bridge.name, runs, ...(origin ? { origin } : {}), sml: sml ? sml.used : null });
}

/** Every listed proposal's live vote set, recounted against the proven list and ProRegTxs, then ranked like Core's candidate. */
async function ranking(req: Extract<WorkerRequest, { kind: 'ranking' }>, bridge: Bridge, progress: (m: string) => void) {
  if (req.dapi.kind !== 'live') throw new Error('the funding order needs live DAPI nodes');
  const dapi = await dapiFor(req.dapi);
  const a = await anchor(dapi, progress);
  const { entries } = smlEntries(a);
  const th = await threshold(dapi, a, req.network, proRegCache(req.network), progress);
  const lists = new Map<number, Promise<BridgeMnList>>();
  const recounts: RecountedProposal[] = [];
  // Each recount must reproduce the tally the bridge published for that height, like the per-proposal check ("Tally verified").
  const published = await bridge.tallies();
  for (const [i, p] of req.proposals.entries()) {
    progress(`Recounting ${p.name} (${i + 1} of ${req.proposals.length})`);
    const base = { govHash: p.govHash, name: p.name, amount: p.paymentAmount, startEpoch: p.startEpoch, endEpoch: p.endEpoch };
    try {
      const votes = await bridge.votes(p.govHash);
      if (!lists.has(votes.tallyHeight)) lists.set(votes.tallyHeight, bridge.mnlist(votes.tallyHeight));
      const list = await lists.get(votes.tallyHeight)!;
      const proReg = await proRegFor(dapi, req.network, votes, list, progress);
      const tally = published.find((t) => t.govHash === p.govHash && t.asOfHeight === votes.tallyHeight);
      const r = verifyVotes({ govHash: p.govHash, votes: votes.votes, masternodes: list.masternodes, network: req.network, now: req.now, targets: tally ? [{ name: BRIDGE_TARGET, tally }] : [], sml: entries, proReg });
      const matches = !!tally && r.targets[0]!.matches;
      const bad = Object.entries(r.problems).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/-/g, ' ')}`);
      const problem = a.weak ? `not secure: ${a.weak}` : r.keysFrom !== 'sml' ? `not every vote proven (${bad.join(', ') || 'keys'})` : !tally ? `no published tally at block ${votes.tallyHeight}` : !matches ? 'the recount differs from the published tally' : null;
      recounts.push({ ...base, absYes: r.weighted.yes - r.weighted.no, proven: problem === null, ...(problem ? { problem } : {}) });
    } catch (e) {
      recounts.push({ ...base, absYes: 0, proven: false, problem: `not recounted: ${(e as Error).message}` });
    }
  }
  const sb = scheduleAndBudget(a, req.network, req.now);
  return rankRecounts(recounts, th, sb.budget, Math.round(req.now + (sb.schedule.next - a.tip) * EST_BLOCK_SECONDS), a.weak);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  handle(ev.data).catch((e: unknown) => post({ id: ev.data.id, kind: 'error', message: e instanceof Error ? e.message : String(e) }));
};
