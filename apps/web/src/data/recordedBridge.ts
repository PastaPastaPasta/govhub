// Recorded mainnet bridge data for fixture mode: the signed votes the bridge captured from Core's ZMQ feed for three
// proposals (services/bridge/test/fixtures/mainnet-votes.json), with the masternode entries of their voters and the tally and
// voteSetHash the bridge computed from them (equal to Core's FundingResult and current vote set). Unlike the synthetic voters of
// fixtureVotes.ts, these are real votes by real masternodes: the web recount must reproduce the recorded tally from them.
import { hexToBytes } from '@govhub/verify';
import { base64 } from '@scure/base';
import { parseRawVote } from '../../../../services/bridge/src/core/govparse.ts';
import type { BridgeMasternode, BridgeVote } from './bridge.ts';
import type { Tally } from './types.ts';

interface VotesFile {
  mnList: {
    height: number;
    listHash: string;
    entries: Array<{ proTxHash: string; collateralTxid: string; collateralIndex: number; type: 'Regular' | 'Evo'; votingAddress: string; isValid: boolean }>;
  };
  proposals: Array<{
    govHash: string;
    tally: { yesCount: number; noCount: number; abstainCount: number; voteSetHash: string };
    votes: Array<{ rawHex: string }>;
  }>;
}

export interface RecordedProposal {
  /** Counts and voteSetHash as the bridge computed them. Rank, funding and margin are not part of the recording. */
  tally: Pick<Tally, 'yesCount' | 'noCount' | 'abstainCount' | 'voteSetHash'>;
  votes: BridgeVote[];
}

export interface RecordedBridge {
  /**
   * The height the bridge's own API serves this data at (the masternode snapshot's height; its test world computes the tallies
   * there). The recording compared the same set with Core a few blocks earlier; no vote changed in between.
   */
  height: number;
  listHash: string;
  masternodes: BridgeMasternode[];
  proposals: Map<string, RecordedProposal>;
}

let recorded: Promise<RecordedBridge> | null = null;

export function loadRecordedBridge(): Promise<RecordedBridge> {
  recorded ??= import('../../../../services/bridge/test/fixtures/mainnet-votes.json').then((m) => decode(m.default as unknown as VotesFile));
  return recorded;
}

export function decode(f: VotesFile): RecordedBridge {
  const proposals = new Map<string, RecordedProposal>();
  for (const p of f.proposals) {
    const votes = p.votes.map(({ rawHex }): BridgeVote => {
      const v = parseRawVote(hexToBytes(rawHex));
      return { collateralTxid: v.outpoint.txid, collateralIndex: v.outpoint.n, signal: v.signal, outcome: v.outcome, time: v.time, sig: base64.encode(v.sig) };
    });
    proposals.set(p.govHash, { tally: { yesCount: p.tally.yesCount, noCount: p.tally.noCount, abstainCount: p.tally.abstainCount, voteSetHash: p.tally.voteSetHash }, votes });
  }
  const masternodes = f.mnList.entries.map((e): BridgeMasternode => ({
    proTxHash: e.proTxHash,
    collateralTxid: e.collateralTxid,
    collateralIndex: e.collateralIndex,
    votingAddress: e.votingAddress,
    type: e.type === 'Evo' ? 'evo' : 'regular',
    valid: e.isValid,
  }));
  return { height: f.mnList.height, listHash: f.mnList.listHash, masternodes, proposals };
}
