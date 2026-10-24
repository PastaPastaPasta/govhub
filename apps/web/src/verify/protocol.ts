// Messages between the page and the verification worker. Everything is structured-clone safe.
import type { DapiConfig } from '../data/dapi.ts';
import type { Proposal, Tally } from '../data/types.ts';
import type { CollateralVerdict } from './collateral.ts';
import type { VoteCheckResult } from './votes.ts';

export type BridgeDescriptor = { kind: 'http'; name: string; base: string } | { kind: 'fixture' };
export type DapiDescriptor = { kind: 'live'; cfg: DapiConfig } | { kind: 'recorded' };

export type WorkerRequest =
  | { id: number; kind: 'collateral'; proposal: Proposal; dapi: DapiDescriptor }
  | {
      id: number;
      kind: 'votes';
      govHash: string;
      expected: Tally | null;
      bridge: BridgeDescriptor;
      dapi: DapiDescriptor;
      network: 'mainnet' | 'testnet';
      now: number;
      crossCheckSml: boolean;
    };

export type WorkerResponse =
  | { id: number; kind: 'progress'; message: string }
  | { id: number; kind: 'collateral'; verdict: CollateralVerdict }
  | { id: number; kind: 'votes'; result: VoteCheckResult; bridge: string; mnlistHeight: number; votesAsOf: number; sml: { node: string; validWeighted: number } | null }
  | { id: number; kind: 'error'; message: string };
