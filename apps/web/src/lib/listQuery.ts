// Search, sort and filter for the proposal lists, kept in the URL query (?q=, ?sort=, ?status=, ?unvoted=1) so a view can be shared
// and the back button steps through it. Defaults are left out of the URL: the bare / and /past are the lists as they always were.
import type { Proposal } from '../data/types.ts';
import { byRank, type Row } from './view.ts';

/** Lowercase, with the separators proposal names use (DCG-Operations_Q3, alice.dash) read as spaces. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_./:]+/g, ' ').trim();
}

/** Every word of the query appears somewhere in the fields (in any order, any field). An empty query matches everything. */
export function matches(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).map((f) => normalize(f!)).join(' | ');
  return words.every((w) => hay.includes(w));
}

/** What a proposal is found by: its name, its URL and payment address, plus whatever names its owner goes by. */
export function proposalFields(p: Proposal, ownerNames: readonly (string | null | undefined)[] = []): (string | null | undefined)[] {
  return [p.name, p.url, p.paymentAddress, ...ownerNames];
}

// ---- Active ------------------------------------------------------------------------------------

export const ACTIVE_SORTS = ['rank', 'newest', 'ending', 'amount'] as const;
export type ActiveSort = (typeof ACTIVE_SORTS)[number];
export const ACTIVE_SORT_LABEL: Record<ActiveSort, string> = { rank: 'Funding order', newest: 'Newest', ending: 'Ending soonest', amount: 'Largest amount' };

export const STATUSES = ['all', 'passing', 'failing'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = { all: 'All', passing: 'Passing', failing: 'Not passing' };

export interface ActiveQuery {
  q: string;
  sort: ActiveSort;
  status: Status;
  unvoted: boolean;
}

const pick = <T extends string>(v: string | null, all: readonly T[], dflt: T): T => (all.includes(v as T) ? (v as T) : dflt);

export function readActive(sp: URLSearchParams): ActiveQuery {
  return {
    q: sp.get('q') ?? '',
    sort: pick(sp.get('sort'), ACTIVE_SORTS, 'rank'),
    status: pick(sp.get('status'), STATUSES, 'all'),
    unvoted: sp.get('unvoted') === '1',
  };
}

/** The query written into `sp` (other parameters kept); defaults are removed. */
export function writeActive(sp: URLSearchParams, a: ActiveQuery): URLSearchParams {
  const out = new URLSearchParams(sp);
  set(out, 'q', a.q || null);
  set(out, 'sort', a.sort === 'rank' ? null : a.sort);
  set(out, 'status', a.status === 'all' ? null : a.status);
  set(out, 'unvoted', a.unvoted ? '1' : null);
  return out;
}

function set(sp: URLSearchParams, k: string, v: string | null) {
  if (v === null) sp.delete(k);
  else sp.set(k, v);
}

/** Passing by the votes shown on the card; no tally (or no cycle yet) is not passing. */
export const isPassing = (r: Row): boolean => !!r.state?.passing;

export function statusOk(r: Row, s: Status): boolean {
  return s === 'all' || (s === 'passing') === isPassing(r);
}

/** Published (unix s): the Platform block time when known, else the proposal's own nTime. */
const published = (p: Proposal): number => (p.createdAt ? p.createdAt / 1000 : p.time);

/** Ties keep funding order, so a sort never shuffles proposals that are equal on its key. */
export function compareActive(sort: ActiveSort): (a: Row, b: Row) => number {
  const key: Record<ActiveSort, ((r: Row) => number) | null> = {
    rank: null,
    newest: (r) => -published(r.p.value),
    ending: (r) => r.p.value.endEpoch,
    amount: (r) => -r.p.value.paymentAmount,
  };
  const k = key[sort];
  return k ? (a, b) => k(a) - k(b) || byRank(a, b) : byRank;
}

/** One line under the tabs saying what order the list is in. */
export const ACTIVE_SORT_NOTE: Record<ActiveSort, string> = {
  rank: 'Best-supported first: the order the treasury pays them in.',
  newest: 'Most recently submitted first.',
  ending: 'The ones whose last payment comes soonest first.',
  amount: 'Largest payment requested first.',
};

// ---- Past --------------------------------------------------------------------------------------

export const PAST_SORTS = ['ended', 'name', 'amount', 'yes'] as const;
export type PastSort = (typeof PAST_SORTS)[number];
export type Dir = 'asc' | 'desc';
/** The direction a column sorts in on its first click: names A–Z, everything else biggest or latest first. */
export const PAST_DEFAULT_DIR: Record<PastSort, Dir> = { ended: 'desc', name: 'asc', amount: 'desc', yes: 'desc' };

export interface PastQuery {
  q: string;
  sort: PastSort;
  dir: Dir;
}

export function readPast(sp: URLSearchParams): PastQuery {
  const sort = pick(sp.get('sort'), PAST_SORTS, 'ended');
  return { q: sp.get('q') ?? '', sort, dir: pick(sp.get('dir'), ['asc', 'desc'] as const, PAST_DEFAULT_DIR[sort]) };
}

export function writePast(sp: URLSearchParams, p: PastQuery): URLSearchParams {
  const out = new URLSearchParams(sp);
  set(out, 'q', p.q || null);
  set(out, 'sort', p.sort === 'ended' ? null : p.sort);
  set(out, 'dir', p.dir === PAST_DEFAULT_DIR[p.sort] ? null : p.dir);
  return out;
}

/** Clicking a column header: the same column flips its direction, another one starts in its own default direction. */
export function nextPastSort(cur: PastQuery, col: PastSort): PastQuery {
  return { ...cur, sort: col, dir: cur.sort === col ? (cur.dir === 'asc' ? 'desc' : 'asc') : PAST_DEFAULT_DIR[col] };
}

/** The list as Platform pages it: newest end first. Anything else, or a search, needs every page loaded. */
export const pastNeedsAll = (p: PastQuery): boolean => !!p.q.trim() || p.sort !== 'ended' || p.dir !== 'desc';

/** `yes`: net yes votes, null when there is no tally (always sorted last, either direction). */
export function comparePast(sort: PastSort, dir: Dir, yes: (p: Proposal) => number | null): (a: Proposal, b: Proposal) => number {
  const sign = dir === 'asc' ? 1 : -1;
  const tie = (a: Proposal, b: Proposal) => b.endEpoch - a.endEpoch || (a.govHash < b.govHash ? -1 : a.govHash > b.govHash ? 1 : 0);
  return (a, b) => {
    if (sort === 'yes') {
      const ya = yes(a);
      const yb = yes(b);
      if (ya === null || yb === null) return ya === yb ? tie(a, b) : ya === null ? 1 : -1;
      return sign * (ya - yb) || tie(a, b);
    }
    const d = sort === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : sort === 'amount' ? a.paymentAmount - b.paymentAmount : a.endEpoch - b.endEpoch;
    return sign * d || tie(a, b);
  };
}
