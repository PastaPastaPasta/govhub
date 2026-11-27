// Masternode polls: Dash Platform's decision proposals (protocol version 15). Any identity puts a question to the masternodes; the
// result is signaling only, nothing on Platform acts on it. Two kinds:
//  - yes/no (`proposal`): creating one opens a masternode yes/no poll and pays its 0.5 DASH fund. It carries its own rule: yes must
//    be strictly more than `passPercent` of yes + no, and yes + no must reach `minimumTurnoutPercent` of the network's voting power
//    when it closes, at `endDate` (1 to 4 weeks out).
//  - multiple choice (`multipleChoiceProposal` and its `choice` documents): the choices contend in a masternode contest that the
//    first choice opens. Most votes wins (earliest choice on a tie); "none of the choices" (a lock) keeps none when it leads.
// A masternode counts 1 and an evonode 4; PoSe-banned ones are left out. Pure logic here; reads are in source.ts.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { CoreNetwork } from '../data/types.ts';

/** The decision proposals system contract: the same id on every network, from protocol version 15. */
export const DECISIONS_CONTRACT_ID = '3iNyoNwjCTkb7XS3RHyWUtLx7pgC6AFAEQNNDHzxqngF';

/** What creating costs, besides Platform's processing fees: the yes/no poll's fund, the multiple choice fee and each choice's fund. */
export const YES_NO_FUND_DUFFS = 50_000_000;
export const MULTIPLE_CHOICE_FEE_DUFFS = 20_000_000;
/** A choice's fund while its contest holds fewer than 250 choices (it doubles at 250, and again every 50 more). */
export const CHOICE_FUND_DUFFS = 10_000_000;

/** The rule limits Platform holds a yes/no poll to. */
export const PASS_PERCENT = { min: 50, max: 80 } as const;
export const TURNOUT_PERCENT = { min: 0, max: 50 } as const;
const DAY_MS = 86_400_000;
export const DURATION_MS = { min: 7 * DAY_MS, max: 28 * DAY_MS } as const;
/** A yes/no poll's text can be edited this long after it is created, or a fifth of its run if that is shorter. */
const YES_NO_EDIT_MS = DAY_MS;
/** A multiple choice poll's title, url and description can be changed for two hours. */
const MULTIPLE_CHOICE_EDIT_MS = 2 * 3_600_000;
export const TITLE_MAX = 128;
export const DESCRIPTION_MAX = 4096;
export const URL_MAX = 512;

/**
 * How long a multiple choice contest runs from its first choice (Platform's contest settings: 90 minutes on testnet), and how long new
 * choices may join it (a week on every network, so on testnet for the whole vote).
 */
export const contestRun = (network: CoreNetwork): { voteMs: number; joinMs: number } =>
  network === 'testnet' ? { voteMs: 90 * 60_000, joinMs: 90 * 60_000 } : { voteMs: 14 * DAY_MS, joinMs: 7 * DAY_MS };

export type PollKind = 'yn' | 'mc';

export interface YesNoPoll {
  kind: 'yn';
  id: string;
  ownerId: string;
  title: string;
  description: string;
  url: string | null;
  passPercent: number;
  minimumTurnoutPercent: number;
  /** ms */
  endDate: number;
  /** ms */
  createdAt: number;
  updatedAt: number;
  revision: number;
}

/** A Platform document a multiple choice poll points at for what is being decided (moderated by an elected team). */
export interface DescriptionRef {
  id: string;
  contractId: string;
  documentType: string;
}

export interface ChoicePoll {
  kind: 'mc';
  id: string;
  ownerId: string;
  title: string;
  url: string | null;
  description: DescriptionRef | null;
  /** anyone may enter choices; when false only the owner may */
  open: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export type Poll = YesNoPoll | ChoicePoll;

export interface YesNoTally {
  yes: number;
  no: number;
  abstain: number;
}

export interface YesNoState {
  /** 'open' while the poll takes votes; 'finished' once Platform recorded its result */
  status: 'open' | 'finished';
  /** voting power so far, or the final one */
  tally: YesNoTally;
  /** what the result recorded: whether it passed and the yes + no voting power it needed */
  result: { passed: boolean; required: number; at: number | null } | null;
}

export interface PollChoice {
  /** the choice's document id: what a vote for it carries */
  id: string;
  /** the choice's text: gone from Platform for the choices not kept once the vote ended */
  title?: string;
  description?: string;
  ownerId?: string;
  votes: number;
}

export interface ChoiceState {
  /** most votes first */
  choices: PollChoice[];
  abstain: number;
  /** "none of the choices" (a lock) */
  none: number;
  total: number;
  /** once the vote ended: the choice kept (null: none was) and when */
  result: { keptId: string | null; at: number | null } | null;
}

// ---- yes/no rule -------------------------------------------------------------------------------

/** Platform's pass rule: yes strictly more than `passPercent` of yes + no (abstentions on neither side, so at 50 a tie fails). */
export const meetsThreshold = (t: Pick<YesNoTally, 'yes' | 'no'>, passPercent: number): boolean => t.yes + t.no > 0 && t.yes * 100 > passPercent * (t.yes + t.no);

/** The yes + no voting power a poll needs, out of the network's total: `minimumTurnoutPercent` of it, rounded up. */
export const requiredPower = (totalPower: number, minimumTurnoutPercent: number): number => Math.ceil((totalPower * minimumTurnoutPercent) / 100);

/** Masternode voting power of a masternode list: 1 per masternode, 4 per evonode, PoSe-banned ones left out. */
export function totalVotingPower(mns: readonly { isValid: boolean; nType: number }[]): number {
  return mns.reduce((s, m) => s + (m.isValid ? (m.nType === 1 ? 4 : 1) : 0), 0);
}

export interface YesNoOutlook {
  /** yes as a share of yes + no, 0..1 (null without yes or no votes) */
  yesShare: number | null;
  meetsThreshold: boolean;
  /** yes + no voting power so far */
  turnout: number;
  /** what the turnout must reach: Platform's recorded figure once finished, else estimated from the current masternode list */
  required: number | null;
  requiredIsFinal: boolean;
  /** null when the required turnout is not known */
  meetsTurnout: boolean | null;
  /** passing as things stand (or passed): null when the turnout part cannot be told */
  passing: boolean | null;
}

export function yesNoOutlook(poll: Pick<YesNoPoll, 'passPercent' | 'minimumTurnoutPercent'>, state: YesNoState, totalPower: number | null): YesNoOutlook {
  const t = state.tally;
  const turnout = t.yes + t.no;
  const threshold = meetsThreshold(t, poll.passPercent);
  const final = state.result;
  const required = final ? final.required : totalPower !== null ? requiredPower(totalPower, poll.minimumTurnoutPercent) : poll.minimumTurnoutPercent === 0 ? 0 : null;
  const meetsTurnout = required === null ? null : turnout >= required;
  return {
    yesShare: turnout ? t.yes / turnout : null,
    meetsThreshold: threshold,
    turnout,
    required,
    requiredIsFinal: !!final,
    meetsTurnout,
    passing: final ? final.passed : !threshold ? false : meetsTurnout,
  };
}

// ---- status ------------------------------------------------------------------------------------

export type Phase = 'open' | 'closing' | 'ended';

/** A yes/no poll at `nowMs`: open, past its end but not recorded yet (the next block finishes it), or ended. */
export function yesNoPhase(poll: Pick<YesNoPoll, 'endDate'>, state: YesNoState | null, nowMs: number): Phase {
  if (state?.status === 'finished') return 'ended';
  return poll.endDate <= nowMs ? 'closing' : 'open';
}

/** A multiple choice poll: waiting for its first choice, open, past its end, or ended. `endsAt` comes from the open contests. */
export type ChoicePhase = 'nochoices' | Phase;

export function choicePhase(state: ChoiceState | null, endsAt: number | null, nowMs: number): ChoicePhase {
  if (state?.result) return 'ended';
  if (state && state.choices.length === 0) return 'nochoices';
  if (endsAt !== null && endsAt <= nowMs) return 'closing';
  return 'open';
}

/** Until when the poll's owner can edit its text (ms). */
export function editableUntil(poll: Poll): number {
  if (poll.kind === 'mc') return poll.createdAt + MULTIPLE_CHOICE_EDIT_MS;
  return poll.createdAt + Math.min(YES_NO_EDIT_MS, Math.floor((poll.endDate - poll.createdAt) / 5));
}

/** Whole percent, "<1%" for a small non-zero share. */
export function pct(part: number, whole: number): string {
  const f = whole > 0 ? part / whole : 0;
  if (f === 0) return '0%';
  if (f < 0.01) return '<1%';
  return `${Math.round(f * 100)}%`;
}

// ---- keys --------------------------------------------------------------------------------------

/** The held-vote key of a vote on a poll (contests use their label, which never holds a colon). */
export const pollVoteKey = (kind: PollKind, id: string): string => `${kind}:${id}`;

export function parsePollVoteKey(key: string): { kind: PollKind; id: string } | null {
  const m = /^(yn|mc):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(key);
  return m ? { kind: m[1] as PollKind, id: m[2]! } : null;
}

/**
 * The key a poll's discussion hangs off: forum comments carry a 32-byte `govHash`, and for a poll it is this hash of the poll's
 * document. Domain-separated, so it never equals a governance hash or a contest's key. It must never change.
 */
export const pollDiscussionKey = (id: string): string => bytesToHex(sha256(utf8ToBytes(['govhub-decision-v1', DECISIONS_CONTRACT_ID, id].join('\n'))));

export const pollHref = (id: string): string => `/polls/${encodeURIComponent(id)}`;

/** A base58 Platform identifier. */
export const isIdentifier = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** A poll's url as a link: only http(s) (Platform takes any URI, `javascript:` included); null otherwise. */
export function linkUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
