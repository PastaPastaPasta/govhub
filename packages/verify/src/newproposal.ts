// Creating a new proposal: the amount Core will actually pay, the superblock-aligned schedule, and one check that combines Core's
// own validation with the rules that decide whether the proposal can ever be paid.
// Dash Core: /Users/pasta/workspace/dash at f35a24cfca12; citations are file:line there.
//
// What Core enforces where:
//   gobject check/prepare/submit  governance::ValidateProposal (object.cpp:1000-1034) with fCheckExpiration=true (object.h:367):
//                                 512-byte data (object.cpp:33,278), name [-_a-z0-9]{1,40} after ToLower (object.cpp:34,100-121),
//                                 end_epoch > start_epoch and > now (object.cpp:127-153), payment_amount > 0 (object.cpp:156-174),
//                                 payment_address P2PKH or P2SH of this network (object.cpp:177-205, fAllowScript=true),
//                                 url >= 4 bytes, no whitespace, balanced brackets (object.cpp:207-271). `validateProposalData`.
//   collateral                    IsCollateralValid (object.cpp:790-870): every output P2PKH or unspendable, one OP_RETURN
//                                 PUSH32(raw gov hash) worth >= GOVERNANCE_PROPOSAL_FEE_TX = 1 DASH (object.h:87), mined, and
//                                 >= GOVERNANCE_FEE_CONFIRMATIONS = 6 confirmations (object.h:88; 1-5 = postponed, 0 = rejected).
//   time                          nothing: the 1 h future limit (MAX_TIME_FUTURE_DEVIATION, governance.cpp:36,753) is checked for
//                                 triggers only (MasternodeRateCheck returns early for every other type, governance.cpp:735-738)
//                                 and for votes (vote.cpp:213). The time is hashed, so the wizard fixes it when the proposal is locked.
//   payment (not at submission!)  the superblock trigger re-parses payment_amount's JSON text with ParsePaymentAmount
//                                 (superblock.cpp:22-63, signing.cpp:72): digits and one '.', <= 20 chars, <= 8 decimals, money
//                                 range. A proposal Core accepts can still never be paid if this fails. It is paid at a superblock
//                                 only when it fits the remaining budget (signing.cpp:81) and the superblock's estimated time
//                                 (now + blocks * 2.62 min, signing.cpp:58-59) is inside [start_epoch - 2 h, end_epoch + 2 h]
//                                 (GOVERNANCE_FUDGE_WINDOW, signing.cpp:23,85-97).
import { decodeAddress, type Network } from './address.ts';
import { bytesToHex } from './bytes.ts';
import { governanceObjectHash } from './govhash.ts';
import { buildProposalDataHex, GOVERNANCE_OBJECT_TYPE_PROPOSAL, MAX_PROPOSAL_DATA_BYTES, validateProposal, validateProposalData, type ProposalFields } from './proposal.ts';
import { GOV_CHAIN_PARAMS, isSuperblockHeight, superblockPaymentsLimit } from './superblock.ts';

export const COIN_DUFFS = 100_000_000n;
/** MAX_MONEY (consensus/amount.h): 21,000,000 DASH. */
export const MAX_MONEY_DUFFS = 21_000_000n * COIN_DUFFS;
/** Core's superblock-time estimate (signing.cpp:58-59): 2.62 minutes per block on every network. */
export const SUPERBLOCK_EST_BLOCK_SECONDS = 2.62 * 60;
/** GOVERNANCE_FUDGE_WINDOW (signing.cpp:23). */
export const GOVERNANCE_FUDGE_WINDOW_S = 2 * 3600;

/**
 * ParsePaymentAmount (superblock.cpp:22-63) on the payment_amount's JSON text: what a superblock trigger pays, in duffs. Null where
 * Core throws (the proposal would be skipped by every trigger). ParseFixedPoint (util/strencodings.cpp:352) with 8 decimals: trailing
 * zeros are fine, a 9th significant decimal is not.
 */
export function parsePaymentAmount(text: string): bigint | null {
  if (text.length === 0 || text.length > 20) return null;
  if (!/^[0-9.]+$/.test(text)) return null;
  const dot = text.indexOf('.');
  if (dot === 0) return null;
  if (dot !== -1 && text.indexOf('.', dot + 1) !== -1) return null;
  // ParseFixedPoint: a single leading 0 or a run starting 1-9, then '.' and at least one digit
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.') as [string, string?];
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > 8) return null;
  const duffs = BigInt(whole) * COIN_DUFFS + BigInt((trimmed + '00000000').slice(0, 8));
  if (duffs > MAX_MONEY_DUFFS) return null;
  return duffs;
}

/** The decimal a user typed ("12.5", "0.00000001") to duffs: digits, at most one '.', at most 8 decimals. Null otherwise. */
export function dashToDuffs(input: string): bigint | null {
  const t = input.trim();
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(t)) return null;
  const [whole = '', frac = ''] = t.split('.') as [string, string?];
  if (frac.replace(/0+$/, '').length > 8) return null;
  return BigInt(whole || '0') * COIN_DUFFS + BigInt((frac + '00000000').slice(0, 8));
}

/** Duffs as a DASH string with no trailing zeros ("1.5", "0.00000001"). */
export function duffsToDash(duffs: bigint): string {
  const neg = duffs < 0n;
  const a = neg ? -duffs : duffs;
  const frac = (a % COIN_DUFFS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / COIN_DUFFS}${frac ? `.${frac}` : ''}`;
}

/**
 * The JSON number the serializer writes for `duffs`, and whether a trigger pays exactly that: `JSON.stringify` of the double must
 * be plain decimal text ParsePaymentAmount reads back as the same duffs. Amounts below 1e-6 DASH are written with an exponent and
 * fail; every amount from there up to MAX_MONEY round-trips (shortest double formatting), but the check stays as the guard.
 */
export function paymentAmountNumber(duffs: bigint): { value: number; text: string; payable: boolean } {
  const value = Number(duffs) / 1e8;
  const text = JSON.stringify(value);
  return { value, text, payable: duffs > 0n && parsePaymentAmount(text) === duffs };
}

// ---- schedule ------------------------------------------------------------------------------------------------------------------

export interface ScheduleInput {
  network: Network;
  /** Best block height and the unix time it is measured at (`now`). */
  tipHeight: number;
  now: number;
  /** The superblock of the first payment. */
  firstSuperblock: number;
  /** Number of payments (consecutive superblocks). */
  payments: number;
  /** Seconds per block for the date estimates. Default: Core's 2.62 min (what the trigger itself uses). */
  blockSeconds?: number;
}

export interface PlannedSuperblock {
  height: number;
  /** Estimated unix time of the superblock. */
  estTime: number;
  /** First block of its maturity window: the votes as of here decide the payout (signing.cpp:41-43). */
  votingDeadline: number;
  votingDeadlineEstTime: number;
  /** CSuperblock::GetPaymentsLimit at this height, duffs. */
  budgetLimit: bigint;
}

export interface ProposalSchedule {
  startEpoch: number;
  endEpoch: number;
  superblocks: PlannedSuperblock[];
  /**
   * Every superblock whose estimated time falls inside [start - 2 h, end + 2 h], from the one before the first to the one after the
   * last: Core pays at all of them if the votes and budget allow. On mainnet this equals `superblocks`; on testnet (hourly superblocks,
   * a 2-hour margin) it is wider, and the honest maximum to show.
   */
  eligible: number[];
}

const cycleOf = (n: Network) => {
  const p = GOV_CHAIN_PARAMS[n as 'mainnet' | 'testnet'];
  if (!p) throw new Error(`no governance chain parameters for ${n}`);
  return p;
};

/**
 * Start and end epochs aligned to superblocks the way Dash Core's own proposal dialog does (qt/proposalcreate.cpp:79-104): the start
 * is the midpoint between the superblock before the first payment and the first, the end the midpoint between the last payment's
 * superblock and the next. Unlike that dialog, the times are estimated from the actual distance to those heights (it anchors the first
 * superblock at "now" whichever one was chosen). Half a cycle of slack on each side keeps exactly the chosen superblocks inside Core's
 * window on mainnet even when blocks run a little fast or slow.
 */
export function proposalSchedule(i: ScheduleInput): ProposalSchedule {
  const p = cycleOf(i.network);
  const bs = i.blockSeconds ?? SUPERBLOCK_EST_BLOCK_SECONDS;
  if (!Number.isSafeInteger(i.payments) || i.payments < 1) throw new Error('payments must be a positive integer');
  if (!isSuperblockHeight(i.firstSuperblock, i.network)) throw new Error(`${i.firstSuperblock} is not a superblock height`);
  const est = (h: number) => Math.floor(i.now + (h - i.tipHeight) * bs);
  const c = p.superblockCycle;
  const first = i.firstSuperblock;
  const last = first + (i.payments - 1) * c;
  const startEpoch = est(Math.floor((first - c + first) / 2));
  const endEpoch = est(Math.floor((last + last + c) / 2));
  const superblocks: PlannedSuperblock[] = [];
  for (let h = first; h <= last; h += c) {
    superblocks.push({ height: h, estTime: est(h), votingDeadline: h - p.maturityWindow, votingDeadlineEstTime: est(h - p.maturityWindow), budgetLimit: superblockPaymentsLimit(h, i.network) });
  }
  const eligible: number[] = [];
  const reach = Math.ceil((GOVERNANCE_FUDGE_WINDOW_S + c * bs) / (c * bs)) + 1;
  for (let h = first - reach * c; h <= last + reach * c; h += c) {
    if (h <= 0) continue;
    const t = est(h);
    if (t >= startEpoch - GOVERNANCE_FUDGE_WINDOW_S && t <= endEpoch + GOVERNANCE_FUDGE_WINDOW_S) eligible.push(h);
  }
  return { startEpoch, endEpoch, superblocks, eligible };
}

export interface SuperblockChoice {
  height: number;
  estTime: number;
  votingDeadline: number;
  votingDeadlineEstTime: number;
  /** Blocks left before its voting deadline, from the tip. */
  blocksToDeadline: number;
  /**
   * `closed`: the deadline is too close for the collateral to reach Core's 6 confirmations and the proposal to be on the network before
   * it (the trigger is built from the votes at the deadline). `tight`: open, but less than a few days (mainnet) to gather votes.
   */
  state: 'open' | 'tight' | 'closed';
}

/** Blocks from paying the collateral to the proposal being on the network: 6 confirmations plus a margin for the relay and voting. */
const MIN_BLOCKS_BEFORE_DEADLINE = 12;

/** The next `count` superblocks as first-payment options, each with its voting deadline and whether it can still be reached. */
export function upcomingSuperblocks(network: Network, tipHeight: number, now: number, count = 12, blockSeconds = SUPERBLOCK_EST_BLOCK_SECONDS): SuperblockChoice[] {
  const p = cycleOf(network);
  const c = p.superblockCycle;
  const start = Math.max(p.superblockStartBlock + ((c - (p.superblockStartBlock % c)) % c), tipHeight + 1 + ((c - ((tipHeight + 1) % c)) % c));
  const est = (h: number) => Math.floor(now + (h - tipHeight) * blockSeconds);
  const out: SuperblockChoice[] = [];
  const tightBlocks = Math.max(MIN_BLOCKS_BEFORE_DEADLINE, Math.round((3 * 86400) / blockSeconds));
  for (let k = 0, h = start; k < count; k++, h += c) {
    const deadline = h - p.maturityWindow;
    const left = deadline - tipHeight;
    out.push({
      height: h,
      estTime: est(h),
      votingDeadline: deadline,
      votingDeadlineEstTime: est(deadline),
      blocksToDeadline: left,
      state: left < MIN_BLOCKS_BEFORE_DEADLINE ? 'closed' : left < tightBlocks && c > tightBlocks ? 'tight' : 'open',
    });
  }
  return out;
}

// ---- the combined check --------------------------------------------------------------------------------------------------------

export type NewProposalField = 'name' | 'paymentAddress' | 'paymentAmount' | 'url' | 'schedule' | 'data';

export interface NewProposalIssue {
  field: NewProposalField;
  message: string;
  /** Which rule: Core's validation, the trigger's payment rules, or a govhub safety rule. */
  rule: 'core' | 'payment' | 'govhub';
}

export interface NewProposalInput {
  network: Network;
  name: string;
  paymentAddress: string;
  /** Per payment. */
  paymentDuffs: bigint;
  url: string;
  startEpoch: number;
  endEpoch: number;
  /** unix seconds: Core's expiry check. */
  now: number;
  /** Planned superblocks: the amount must fit each one's whole budget. */
  superblocks?: ReadonlyArray<Pick<PlannedSuperblock, 'height' | 'budgetLimit'>>;
}

export interface NewProposalCheck {
  errors: NewProposalIssue[];
  /** Set when there are no errors: the exact bytes Core will validate and hash. */
  dataHex?: string;
  fields?: ProposalFields;
  dataBytes?: number;
}

/** Core field-rule messages (proposal.ts validateRaw) to the wizard's fields. */
const FIELD_OF: Array<[RegExp, NewProposalField]> = [
  [/^name/, 'name'],
  [/^payment_address/, 'paymentAddress'],
  [/^payment_amount/, 'paymentAmount'],
  [/^url/, 'url'],
  [/start_epoch|end_epoch|expired/, 'schedule'],
];
const coreIssue = (message: string): NewProposalIssue => ({ field: FIELD_OF.find(([re]) => re.test(message))?.[1] ?? 'data', message, rule: 'core' });

/**
 * Everything that decides whether a new proposal is accepted by `gobject prepare`/`submit` and can be paid. Core's own rules are checked
 * on the exact serialized bytes (`validateProposalData`, so the 512-byte cap and the JSON form count), after the field-level pass for
 * per-field messages. The serializer is `buildProposalDataHex` (alphabetical keys, compact JSON).
 */
export function checkNewProposal(i: NewProposalInput): NewProposalCheck {
  const errors: NewProposalIssue[] = [];
  const amount = paymentAmountNumber(i.paymentDuffs);
  const fields: ProposalFields = {
    type: GOVERNANCE_OBJECT_TYPE_PROPOSAL,
    name: i.name,
    paymentAddress: i.paymentAddress,
    paymentAmount: amount.value,
    startEpoch: i.startEpoch,
    endEpoch: i.endEpoch,
    url: i.url,
  };
  errors.push(...validateProposal(fields, i.network, { now: i.now }).errors.map(coreIssue));
  if (i.paymentDuffs > 0n && !amount.payable) {
    errors.push({ field: 'paymentAmount', rule: 'payment', message: `Core's payout code reads this amount as ${amount.text}, not exactly the amount entered: use at most 8 decimals and fewer significant digits` });
  }
  if (i.paymentDuffs > MAX_MONEY_DUFFS) errors.push({ field: 'paymentAmount', rule: 'payment', message: 'more than 21 million DASH' });
  for (const sb of i.superblocks ?? []) {
    if (i.paymentDuffs > sb.budgetLimit) {
      errors.push({ field: 'paymentAmount', rule: 'payment', message: `more than the whole budget of superblock ${sb.height} (${duffsToDash(sb.budgetLimit)} DASH): it could never be paid` });
      break;
    }
  }
  if (errors.length) return { errors };
  let dataHex: string;
  try {
    dataHex = buildProposalDataHex(fields);
  } catch (e) {
    const m = (e as Error).message;
    if (/bytes, max/.test(m)) return { errors: [{ field: 'data', rule: 'core', message: `${m}: shorten the URL or the name (Core's limit is ${MAX_PROPOSAL_DATA_BYTES} bytes)` }] };
    return { errors: [{ field: 'paymentAmount', rule: 'core', message: m }] };
  }
  const v = validateProposalData(dataHex, i.network, { now: i.now });
  if (!v.valid) return { errors: v.errors.map(coreIssue) };
  return { errors: [], dataHex, fields, dataBytes: dataHex.length / 2 };
}

/** A proposal fixed for payment: the time is part of the hash, so everything here must be kept to submit it. */
export interface LockedProposal {
  parentHash: '0';
  revision: 1;
  time: number;
  dataHex: string;
  /** Display order, as `gobject list` prints it. */
  govHash: string;
  /** Raw (internal) order: the bytes in the collateral's OP_RETURN. */
  govHashRaw: string;
}

export function lockProposal(dataHex: string, time: number): LockedProposal {
  if (!Number.isSafeInteger(time) || time <= 0) throw new Error('time must be a positive integer');
  const h = governanceObjectHash({ parentHash: '0', revision: 1, time, dataHex });
  return { parentHash: '0', revision: 1, time, dataHex: dataHex.toLowerCase(), govHash: h.display, govHashRaw: bytesToHex(h.raw) };
}

/** `gobject prepare` for Dash Core's console / dash-cli: burns the fee from the wallet and prints the collateral txid. */
export const gobjectPrepareCommand = (p: Pick<LockedProposal, 'time' | 'dataHex'>): string => `gobject prepare 0 1 ${p.time} ${p.dataHex}`;
/** `gobject submit` once the collateral has 6 confirmations. */
export const gobjectSubmitCommand = (p: Pick<LockedProposal, 'time' | 'dataHex'>, collateralTxid: string): string => `gobject submit 0 1 ${p.time} ${p.dataHex} ${collateralTxid}`;

/** Whether `address` can receive the collateral's change: Core allows only P2PKH and unspendable outputs in it (object.cpp:834-843). */
export function isCollateralChangeAddress(address: string, network: Network): boolean {
  return decodeAddress(address, network)?.type === 'p2pkh';
}
