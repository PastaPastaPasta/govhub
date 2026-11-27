// What creating a masternode poll writes: the documents' data, checked against the contract's rules first (Platform would refuse them
// and still charge its fees). Pure; the pages sign them with the session's key (session.signAndBroadcastDocument, `fund`).
import { base58 } from '@scure/base';
import { CREDITS_PER_DUFF } from '../lib/format.ts';
import { CHOICE_FUND_DUFFS, DECISIONS_CONTRACT_ID, DESCRIPTION_MAX, DURATION_MS, MULTIPLE_CHOICE_FEE_DUFFS, PASS_PERCENT, TITLE_MAX, TURNOUT_PERCENT, URL_MAX } from './model.ts';

type DocValue = Uint8Array | number | string | boolean;
export interface CreateOp {
  action: 'create';
  contractId: string;
  type: string;
  data: Record<string, DocValue>;
  fund?: true;
}

const DAY_MS = 86_400_000;
/** Kept from the edges of Platform's end date window: the block that creates the poll is a little later than now. */
const EDGE_MS = 3_600_000;
/** The most choices the page enters with a new multiple choice poll. */
export const MAX_CHOICES = 10;

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Why a title cannot be used, or null: one line, 1 to 128 characters, at most 512 bytes. */
export function titleProblem(t: string): string | null {
  const v = oneLine(t);
  if (!v) return 'Write the question.';
  if ([...v].length > TITLE_MAX || utf8(v) > 512) return `Keep it to ${TITLE_MAX} characters.`;
  return null;
}

export function textProblem(t: string, required: boolean): string | null {
  const v = t.trim();
  if (!v) return required ? 'Say what a yes and a no mean.' : null;
  if ([...v].length > DESCRIPTION_MAX || utf8(v) > DESCRIPTION_MAX) return `Keep it to ${formatK(DESCRIPTION_MAX)} characters.`;
  return null;
}
const formatK = (n: number) => n.toLocaleString('en-US');
const canParse = (u: string): boolean => {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
};
/** A checked link as Platform should store it: the URL parser's form (spaces and the like escaped), or '' for none. */
const storedUrl = (u: string): string => (u.trim() ? new URL(u.trim()).href : '');

/** A link, if any: http(s) only, at most 512 characters. */
export function urlProblem(u: string, required: boolean): string | null {
  const v = u.trim();
  if (!v) return required ? 'Give the page that says what is being decided.' : null;
  if (v.length > URL_MAX || utf8(v) > URL_MAX || (canParse(v) && utf8(new URL(v).href) > URL_MAX)) return `Keep the link to ${URL_MAX} characters.`;
  try {
    const p = new URL(v);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return 'Use an http or https link.';
  } catch {
    return 'This is not a link (start it with https://).';
  }
  return null;
}

export interface YesNoDraft {
  title: string;
  description: string;
  url: string;
  passPercent: number;
  minimumTurnoutPercent: number;
  /** how long it runs, in days (7 to 28) */
  days: number;
}

export function yesNoProblems(d: YesNoDraft): Partial<Record<keyof YesNoDraft, string>> {
  const out: Partial<Record<keyof YesNoDraft, string>> = {};
  const t = titleProblem(d.title);
  if (t) out.title = t;
  const x = textProblem(d.description, true);
  if (x) out.description = x;
  const u = urlProblem(d.url, false);
  if (u) out.url = u;
  if (!Number.isInteger(d.passPercent) || d.passPercent < PASS_PERCENT.min || d.passPercent > PASS_PERCENT.max) out.passPercent = `From ${PASS_PERCENT.min} to ${PASS_PERCENT.max}.`;
  if (!Number.isInteger(d.minimumTurnoutPercent) || d.minimumTurnoutPercent < TURNOUT_PERCENT.min || d.minimumTurnoutPercent > TURNOUT_PERCENT.max) out.minimumTurnoutPercent = `From ${TURNOUT_PERCENT.min} to ${TURNOUT_PERCENT.max}.`;
  if (!Number.isInteger(d.days) || d.days * DAY_MS < DURATION_MS.min || d.days * DAY_MS > DURATION_MS.max) out.days = 'From 7 to 28 days.';
  return out;
}

/** When a poll asked now for `days` closes: kept an hour inside Platform's one-to-four-week window. */
export function endDateFor(days: number, nowMs: number): number {
  const want = nowMs + days * DAY_MS;
  return Math.min(Math.max(want, nowMs + DURATION_MS.min + EDGE_MS), nowMs + DURATION_MS.max - EDGE_MS);
}

/** The `proposal` document of a yes/no poll. */
export function yesNoOp(d: YesNoDraft, nowMs: number): CreateOp {
  const url = storedUrl(d.url);
  return {
    action: 'create',
    contractId: DECISIONS_CONTRACT_ID,
    type: 'proposal',
    data: {
      title: oneLine(d.title),
      description: d.description.trim(),
      ...(url ? { url } : {}),
      passPercent: d.passPercent,
      minimumTurnoutPercent: d.minimumTurnoutPercent,
      endDate: endDateFor(d.days, nowMs),
    },
    fund: true,
  };
}

export interface ChoiceDraft {
  title: string;
  description: string;
}

export interface ChoicePollDraft {
  title: string;
  url: string;
  /** anyone may enter choices */
  open: boolean;
  choices: ChoiceDraft[];
}

export function choicePollProblems(d: ChoicePollDraft): { title?: string; url?: string; choices: Array<{ title?: string; description?: string }>; count?: string } {
  const out: ReturnType<typeof choicePollProblems> = { choices: [] };
  const t = titleProblem(d.title);
  if (t) out.title = t;
  const u = urlProblem(d.url, true);
  if (u) out.url = u;
  const filled = d.choices.filter((c) => c.title.trim() || c.description.trim());
  if (!d.open && filled.length < 2) out.count = 'Give at least two choices: only you can enter them.';
  if (filled.length > MAX_CHOICES) out.count = `At most ${MAX_CHOICES} here; more can be entered on the poll's page.`;
  out.choices = d.choices.map((c) => {
    if (!c.title.trim() && !c.description.trim()) return {};
    const e: { title?: string; description?: string } = {};
    const ct = titleProblem(c.title);
    if (ct) e.title = ct === 'Write the question.' ? 'Write the choice.' : ct;
    const cd = textProblem(c.description, false);
    if (cd) e.description = cd;
    return e;
  });
  return out;
}

export const hasProblems = (p: ReturnType<typeof choicePollProblems>): boolean => !!(p.title || p.url || p.count || p.choices.some((c) => c.title || c.description));

/** The `multipleChoiceProposal` document (described at a url; Platform charges its 0.2 DASH fee as processing, unstated). */
export function choicePollOp(d: ChoicePollDraft): CreateOp {
  return { action: 'create', contractId: DECISIONS_CONTRACT_ID, type: 'multipleChoiceProposal', data: { title: oneLine(d.title), url: storedUrl(d.url), open: d.open } };
}

/** A `choice` document for a multiple choice poll (it states the contest's fund to join). */
export function choiceOp(proposalId: string, c: ChoiceDraft): CreateOp {
  const description = c.description.trim();
  return { action: 'create', contractId: DECISIONS_CONTRACT_ID, type: 'choice', data: { proposalId: base58.decode(proposalId), title: oneLine(c.title), ...(description ? { description } : {}) }, fund: true };
}

/** What creating a multiple choice poll costs, besides Platform's processing fees (a small fraction of a DASH), in duffs. */
export const choicePollCost = (choices: number): number => MULTIPLE_CHOICE_FEE_DUFFS + choices * CHOICE_FUND_DUFFS;

/** Kept free above a create's fund for Platform's fees and the up-front check (about a hundredth of a DASH). */
const FEE_MARGIN_CREDITS = 1_000_000_000n;

/** Credits a create costing `duffs` (fund and fee) needs available. */
export const needCredits = (duffs: number): bigint => BigInt(duffs) * BigInt(CREDITS_PER_DUFF) + FEE_MARGIN_CREDITS;
