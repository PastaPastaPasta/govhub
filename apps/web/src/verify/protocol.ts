// Messages between the page and the verification worker. Everything is structured-clone safe.
import type { DapiConfig } from '../data/dapi.ts';
import type { Proposal } from '../data/types.ts';
import type { CollateralVerdict } from './collateral.ts';
import type { VoteRun, VoteTarget } from './votes.ts';

export type BridgeDescriptor = { kind: 'http'; name: string; base: string } | { kind: 'fixture' };
export type DapiDescriptor = { kind: 'live'; cfg: DapiConfig } | { kind: 'recorded' };

export type WorkerRequest =
  /** `light`: the node's word for the transaction plus a second node's, without the block proof (background checks of whole lists). */
  | { id: number; kind: 'collateral'; proposal: Proposal; dapi: DapiDescriptor; light?: boolean }
  | {
      id: number;
      kind: 'votes';
      govHash: string;
      targets: VoteTarget[];
      bridge: BridgeDescriptor;
      dapi: DapiDescriptor;
      network: 'mainnet' | 'testnet';
      now: number;
      crossCheckSml: boolean;
    };

export type WorkerResponse =
  | { id: number; kind: 'progress'; message: string }
  | { id: number; kind: 'collateral'; verdict: CollateralVerdict }
  | {
      id: number;
      kind: 'votes';
      bridge: string;
      /** One recount per distinct tally height (the Platform tally's set is fetched with ?height=, the live one without). */
      runs: VoteRun[];
      /** Fixture bridges say whether their votes are recorded mainnet data or synthetic. */
      origin?: 'recorded' | 'synthetic';
      sml: { nodes: string[]; height: number | null; validWeighted: number } | null;
    }
  | { id: number; kind: 'error'; message: string };

export type VotesDone = Extract<WorkerResponse, { kind: 'votes' }>;
