// Messages between the page and the verification worker. Everything is structured-clone safe.
import type { DapiConfig } from '../data/dapi.ts';
import type { CoreNetwork, Proposal } from '../data/types.ts';
import type { AnchorSummary, ChainReport } from './chain.ts';
import type { CollateralVerdict } from './collateral.ts';
import type { RankingResult } from './ranking.ts';
import type { VoteRun, VoteTarget } from './votes.ts';

export type BridgeDescriptor = { kind: 'http'; name: string; base: string } | { kind: 'fixture' };
export type DapiDescriptor = { kind: 'live'; cfg: DapiConfig } | { kind: 'recorded' };

/** The masternode list the recount checked keys against: proven into a block of the verified chain. */
export interface SmlUsed {
  height: number;
  blockHash: string;
  /** The node that sent it (nothing rests on it: the list is proven). */
  node: string;
  validWeighted: number;
  /** The chain the list is proven into is not protected by proof of work (testnet). */
  weak: string | null;
}

export type WorkerRequest =
  /** `light`: the node's word for the transaction plus a second node's, without the block proof (background checks of whole lists). */
  | { id: number; kind: 'collateral'; proposal: Proposal; dapi: DapiDescriptor; light?: boolean }
  /** Chain facts for the page: threshold, schedule, budget, payments. `from`: the collateral's verified height. */
  | {
      id: number; kind: 'chain'; proposal: Proposal; from: number; dapi: DapiDescriptor; network: CoreNetwork; now: number;
      /** Other listed proposals: a payment to the same address and amount inside their window is ambiguous. */
      others: Array<Pick<Proposal, 'govHash' | 'paymentAddress' | 'paymentAmount' | 'startEpoch' | 'endEpoch'>>;
      /** Every listed proposal (active and past) could be read: otherwise a twin may have been missed. */
      othersComplete: boolean;
    }
  | {
      id: number;
      kind: 'votes';
      govHash: string;
      targets: VoteTarget[];
      bridge: BridgeDescriptor;
      dapi: DapiDescriptor;
      network: CoreNetwork;
      now: number;
      crossCheckSml: boolean;
    }
  /** The anchored chain alone (the header's chain shield): trust root, verified tip, ChainLock. */
  | { id: number; kind: 'anchor'; dapi: DapiDescriptor }
  /** Recount every listed proposal's live votes and rank them like Core's superblock candidate. */
  | { id: number; kind: 'ranking'; proposals: Proposal[]; bridge: BridgeDescriptor; dapi: DapiDescriptor; network: CoreNetwork; now: number };

export type WorkerResponse =
  | { id: number; kind: 'progress'; message: string }
  | { id: number; kind: 'collateral'; verdict: CollateralVerdict }
  | { id: number; kind: 'chain'; report: ChainReport }
  | { id: number; kind: 'anchor'; anchor: AnchorSummary }
  | {
      id: number;
      kind: 'votes';
      bridge: string;
      /** One recount per distinct tally height (the Platform tally's set is fetched with ?height=, the live one without). */
      runs: VoteRun[];
      /** Fixture bridges say whether their votes are recorded mainnet data or synthetic. */
      origin?: 'recorded' | 'synthetic';
      sml: SmlUsed | null;
    }
  | { id: number; kind: 'ranking'; result: RankingResult }
  | { id: number; kind: 'error'; message: string };

export type VotesDone = Extract<WorkerResponse, { kind: 'votes' }>;
export type ChainDone = Extract<WorkerResponse, { kind: 'chain' }>;
export type RankingDone = Extract<WorkerResponse, { kind: 'ranking' }>;
