// Domain types. Platform documents (gov.json) are normalised into these: byte arrays become
// lowercase hex in the order they are stored (RPC/display order for every Core hash, per
// packages/contracts-v1 "Hash byte order"), amounts stay in duffs.

export type CoreNetwork = 'mainnet' | 'testnet';

/** Where a value came from. Every number in the UI carries one of these. */
export type ProvenanceKind =
  | 'proof' // read from Dash Platform, GroveDB proof verified by evo-sdk
  | 'reported' // reported by a third party (bridge API, DAPI node, price feed), not verified
  | 'verified' // recomputed / checked against the Core chain over DAPI
  | 'mismatch' // a check ran and failed
  | 'fixture'; // recorded snapshot, not live

export interface Provenance {
  kind: ProvenanceKind;
  /** Human name of the endpoint / contract that supplied it. */
  source: string;
  /** Extra detail: block height, contract id, cache age, what was computed. */
  detail?: string;
}

export interface Sourced<T> {
  value: T;
  prov: Provenance;
}

export interface Proposal {
  govHash: string;
  parentHash: string;
  revision: number;
  /** unix seconds (nTime) */
  time: number;
  dataHex: string;
  name: string;
  url: string;
  paymentAddress: string;
  /** duffs per payment */
  paymentAmount: number;
  startEpoch: number;
  endEpoch: number;
  collateralTxid: string;
  collateralHeight: number;
  /** Platform document id (base58) when read from Platform. */
  docId?: string;
  /** ms, Platform block time of publication. */
  createdAt?: number;
}

export interface Tally {
  govHash: string;
  asOfHeight: number;
  yesWeighted: number;
  noWeighted: number;
  abstainWeighted: number;
  yesCount: number;
  noCount: number;
  abstainCount: number;
  voteSetHash: string;
  rank: number;
  inNextBudget: boolean;
  margin: number;
}

export interface Cycle {
  superblockHeight: number;
  /** duffs */
  budget: number;
  /** duffs */
  allocated: number;
  votingDeadlineHeight: number;
  /** unix seconds */
  estTime: number;
  validWeighted: number;
  /** duffs */
  paid: number;
}
