// Contested DPNS usernames (what vote.dashhq.org showed): a name that more than one identity wants, or that looks like a well-known
// one, waits two weeks (90 minutes on testnet) while masternodes vote on who gets it. Pure logic here; reads are in source.ts.

/** The DPNS system contract: the same id on mainnet and testnet. */
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

/** The contested DPNS index every username contest lives under; its values are ["dash", normalized label]. */
export const DPNS_POLL = {
  dataContractId: DPNS_CONTRACT_ID,
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
} as const;

export const PARENT_DOMAIN = 'dash';

/** Platform's limit: a masternode may change its vote on one contest this many times; the last one counts. */
export const VOTE_CHANGES = 5;
/** Vote weight of an evonode (a regular masternode counts once). */
export const EVONODE_WEIGHT = 4;

/** A contest still open for votes, with its end time (ms of Platform block time). */
export interface OpenContest {
  label: string;
  endsAt: number;
}

export interface Contender {
  identityId: string;
  votes: number;
  /** The name as this contender typed it ("TheRoadNotTaken"), when their document could be read. */
  requested?: string;
}

export type Outcome =
  | { kind: 'won'; identityId: string; at: number | null }
  | { kind: 'locked'; at: number | null }
  | { kind: 'none'; at: number | null };

export interface ContestState {
  /** normalized label, as in the index */
  label: string;
  /** most votes first */
  contenders: Contender[];
  abstain: number;
  lock: number;
  total: number;
  outcome: Outcome | null;
  /** Platform height the state was proven at, when known */
  height: number | null;
}

/**
 * DPNS homograph-safe form (convertToHomographSafeChars): lower case, with o→0 and i, l→1. The index, and so the contest, uses this form.
 */
export function normalizeLabel(name: string): string {
  return name
    .trim()
    .replace(/\.dash$/i, '')
    .toLowerCase()
    .replace(/o/g, '0')
    .replace(/[il]/g, '1');
}

/** Labels in the contested index: 3 to 19 of a-z, 0, 1 and hyphen (after normalization). */
export const isContestedLabel = (label: string): boolean => /^[a-z01-]{3,19}$/.test(label);

/** The spelling to show: the leading contender's own, else the normalized label. */
export function displayName(s: Pick<ContestState, 'contenders' | 'label'> | null | undefined, label: string): string {
  return s?.contenders.find((c) => c.requested)?.requested ?? label;
}

/** The normalized label to mention under the shown spelling, when they differ by more than letter case ("TheRoadNotTaken" → "theroadn0ttaken"). */
export const registersAs = (shown: string, label: string): string | null => (shown.toLowerCase() === label ? null : label);

export function share(votes: number, total: number): number {
  return total > 0 ? votes / total : 0;
}

/** Whole percent, "<1%" for a small non-zero share. */
export function percent(votes: number, total: number): string {
  const f = share(votes, total);
  if (f === 0) return '0%';
  if (f < 0.01) return '<1%';
  return `${Math.round(f * 100)}%`;
}

/** The status of a contest at `nowMs`: open, closed but not yet decided (finalization runs in the next block), or decided. */
export type Phase = 'open' | 'closing' | 'decided';

export function phaseOf(state: ContestState | null, endsAt: number | null, nowMs: number): Phase {
  if (state?.outcome) return 'decided';
  if (endsAt !== null && endsAt <= nowMs) return 'closing';
  return 'open';
}

/** Outcome kinds from the SDK's winner info ("WonByIdentity", "Locked", "NoWinner"). */
export function toOutcome(kind: string, identityId: string | undefined, at: number | null): Outcome {
  if (identityId) return { kind: 'won', identityId, at };
  if (/lock/i.test(kind)) return { kind: 'locked', at };
  return { kind: 'none', at };
}
