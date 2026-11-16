import { describe, expect, it } from 'vitest';
import type { Proposal, Sourced } from '../data/types.ts';
import { compareActive, comparePast, matches, nextPastSort, normalize, pastNeedsAll, proposalFields, readActive, readPast, statusOk, writeActive, writePast } from './listQuery.ts';
import type { Row } from './view.ts';

const prov = { kind: 'proof', source: 'test' } as const;
const proposal = (over: Partial<Proposal>): Proposal => ({
  govHash: 'aa',
  parentHash: '0',
  revision: 1,
  time: 0,
  dataHex: '',
  name: 'p',
  url: '',
  paymentAddress: 'Xaddr',
  paymentAmount: 1e8,
  startEpoch: 0,
  endEpoch: 0,
  collateralTxid: '',
  collateralHeight: 0,
  ...over,
});
const row = (over: Partial<Proposal>, absYes: number | null, passing?: boolean): Row =>
  ({ p: { value: proposal(over), prov } as Sourced<Proposal>, absYes, state: passing === undefined ? null : { passing, margin: 0, needed: 0, light: passing ? 'pass' : 'fail' } }) as Row;
const names = (rs: Row[]) => rs.map((r) => r.p.value.name);

describe('search', () => {
  it('reads proposal-name separators as spaces and ignores case', () => {
    expect(normalize('DCG-Operations_Aug.Nov/26')).toBe('dcg operations aug nov 26');
    expect(matches('dcg operations', ['DCG-Operations-Aug-Nov-26'])).toBe(true);
    expect(matches('Operations-DCG', ['DCG-Operations-Aug-Nov-26'])).toBe(true);
  });
  it('needs every word, but each may come from any field', () => {
    const fields = proposalFields(proposal({ name: 'OrchardPay', url: 'https://www.dashcentral.org/p/OrchardPay' }), ['alice.dash', 'Alice W']);
    expect(matches('orchard alice', fields)).toBe(true);
    expect(matches('alice.dash', fields)).toBe(true);
    expect(matches('orchard bob', fields)).toBe(false);
  });
  it('finds a payment address', () => {
    expect(matches('XdWkmF', proposalFields(proposal({ paymentAddress: 'XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62' })))).toBe(true);
  });
  it('an empty or blank query matches everything', () => {
    expect(matches('', [])).toBe(true);
    expect(matches('  - ', ['x'])).toBe(true);
  });
  it('never matches across a field boundary', () => {
    expect(matches('pay alice', ['orchardpay', 'alice'])).toBe(true);
    expect(matches('payalice', ['orchardpay', 'alice'])).toBe(false);
  });
});

describe('active list', () => {
  const a = row({ govHash: 'a1', name: 'a', paymentAmount: 5e8, endEpoch: 300, time: 10 }, 500, true);
  const b = row({ govHash: 'b1', name: 'b', paymentAmount: 9e8, endEpoch: 100, time: 30 }, 200, false);
  const c = row({ govHash: 'c1', name: 'c', paymentAmount: 1e8, endEpoch: 200, time: 20, createdAt: 40_000 }, 300, true);
  it('funding order by default; ties on another key keep funding order', () => {
    expect(names([b, c, a].sort(compareActive('rank')))).toEqual(['a', 'c', 'b']);
    expect(names([b, c, a].sort(compareActive('newest')))).toEqual(['c', 'b', 'a']); // c: published at Platform block time 40 s
    expect(names([a, b, c].sort(compareActive('ending')))).toEqual(['b', 'c', 'a']);
    expect(names([a, b, c].sort(compareActive('amount')))).toEqual(['b', 'a', 'c']);
    const twin = row({ govHash: 'd1', name: 'd', paymentAmount: 9e8 }, 900, true);
    expect(names([b, twin].sort(compareActive('amount')))).toEqual(['d', 'b']);
  });
  it('status: no tally is not passing', () => {
    const none = row({}, null);
    expect([a, b, c, none].filter((r) => statusOk(r, 'passing')).map((r) => r.p.value.name)).toEqual(['a', 'c']);
    expect([a, b, c, none].filter((r) => statusOk(r, 'failing')).map((r) => r.p.value.name)).toEqual(['b', 'p']);
    expect([a, b, c, none].filter((r) => statusOk(r, 'all'))).toHaveLength(4);
  });
});

describe('active URL state', () => {
  it('defaults are left out of the URL, other parameters are kept', () => {
    const sp = new URLSearchParams('fixtures=1&sort=amount&status=passing&unvoted=1&q=x');
    expect(writeActive(sp, { q: '  ', sort: 'rank', status: 'all', unvoted: false }).toString()).toBe('fixtures=1');
  });
  it('round-trips', () => {
    const q = { q: 'dash pay', sort: 'ending', status: 'failing', unvoted: true } as const;
    expect(readActive(writeActive(new URLSearchParams(), q))).toEqual(q);
  });
  it('an unknown value falls back to the default', () => {
    expect(readActive(new URLSearchParams('sort=bogus&status=nope&unvoted=yes'))).toEqual({ q: '', sort: 'rank', status: 'all', unvoted: false });
  });
});

describe('past list', () => {
  const p = (name: string, endEpoch: number, paymentAmount: number, govHash = name) => proposal({ name, endEpoch, paymentAmount, govHash });
  const x = p('Alpha', 100, 5);
  const y = p('beta', 300, 1);
  const z = p('Gamma-10', 200, 9);
  const z2 = p('Gamma-9', 150, 9);
  const yes = new Map([
    ['Alpha', 50],
    ['beta', -10],
  ]);
  const yesOf = (q: Proposal) => yes.get(q.govHash) ?? null;
  const sorted = (sort: Parameters<typeof comparePast>[0], dir: 'asc' | 'desc') => [x, y, z, z2].sort(comparePast(sort, dir, yesOf)).map((q) => q.name);
  it('sorts by each column, either way', () => {
    expect(sorted('ended', 'desc')).toEqual(['beta', 'Gamma-10', 'Gamma-9', 'Alpha']);
    expect(sorted('ended', 'asc')).toEqual(['Alpha', 'Gamma-9', 'Gamma-10', 'beta']);
    // names: case-insensitive, numbers in order
    expect(sorted('name', 'asc')).toEqual(['Alpha', 'beta', 'Gamma-9', 'Gamma-10']);
    // equal amounts: the later end first
    expect(sorted('amount', 'desc')).toEqual(['Gamma-10', 'Gamma-9', 'Alpha', 'beta']);
  });
  it('proposals without a tally sort last by net yes, either way', () => {
    expect(sorted('yes', 'desc')).toEqual(['Alpha', 'beta', 'Gamma-10', 'Gamma-9']);
    expect(sorted('yes', 'asc')).toEqual(['beta', 'Alpha', 'Gamma-10', 'Gamma-9']);
  });
  it('a header click flips the same column, and starts another in its own direction', () => {
    const start = readPast(new URLSearchParams());
    expect(start).toEqual({ q: '', sort: 'ended', dir: 'desc' });
    expect(nextPastSort(start, 'ended')).toEqual({ q: '', sort: 'ended', dir: 'asc' });
    expect(nextPastSort(start, 'name')).toEqual({ q: '', sort: 'name', dir: 'asc' });
    expect(nextPastSort(start, 'amount')).toEqual({ q: '', sort: 'amount', dir: 'desc' });
  });
  it('URL: only what differs from the default', () => {
    expect(writePast(new URLSearchParams('fixtures=1'), { q: '', sort: 'ended', dir: 'desc' }).toString()).toBe('fixtures=1');
    expect(writePast(new URLSearchParams(), { q: '', sort: 'name', dir: 'asc' }).toString()).toBe('sort=name');
    expect(writePast(new URLSearchParams(), { q: 'x', sort: 'name', dir: 'desc' }).toString()).toBe('q=x&sort=name&dir=desc');
    expect(readPast(new URLSearchParams('sort=name&dir=desc'))).toEqual({ q: '', sort: 'name', dir: 'desc' });
  });
  it('only the default view can show pages as they come; anything else reads every page first', () => {
    expect(pastNeedsAll({ q: '', sort: 'ended', dir: 'desc' })).toBe(false);
    expect(pastNeedsAll({ q: ' ', sort: 'ended', dir: 'desc' })).toBe(false);
    expect(pastNeedsAll({ q: 'x', sort: 'ended', dir: 'desc' })).toBe(true);
    expect(pastNeedsAll({ q: '', sort: 'ended', dir: 'asc' })).toBe(true);
    expect(pastNeedsAll({ q: '', sort: 'amount', dir: 'desc' })).toBe(true);
  });
});
