import { describe, expect, it } from 'vitest';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { paymentText } from '../ui/ProposalCard.tsx';
import { GOV_PARAMS } from './governance.ts';
import { byRank, countNames, deriveRow, pickTally, proposalHref } from './view.ts';

const prov = { kind: 'proof', source: 'test' } as const;
const tally = (govHash: string, over: Partial<Tally> = {}): Sourced<Tally> => ({
  value: { govHash, asOfHeight: 100, yesWeighted: 400, noWeighted: 20, abstainWeighted: 0, yesCount: 300, noCount: 20, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget: true, margin: 0, ...over },
  prov,
});
const proposal = (govHash: string, name: string): Sourced<Proposal> => ({
  value: { govHash, parentHash: '0'.repeat(64), revision: 1, time: 0, dataHex: '', name, url: '', paymentAddress: 'X', paymentAmount: 1e8, startEpoch: 0, endEpoch: 2e9, collateralTxid: '', collateralHeight: 0 },
  prov,
});

describe('view model', () => {
  it('shows the fresher tally: bridge only when it is newer than Platform', () => {
    const p = tally('a');
    const b = { ...tally('a', { asOfHeight: 101 }), prov: { kind: 'reported', source: 'bridge' } as const };
    expect(pickTally(p, b)).toBe(b);
    const same = { ...b, value: { ...b.value, asOfHeight: 100 } };
    expect(pickTally(p, same)).toBe(p);
    expect(pickTally(null, b)).toBe(b);
    expect(pickTally(undefined, undefined)).toBeNull();
  });

  it('derives pass state against 10% of the cycle weight', () => {
    const cycle = { value: { superblockHeight: 1, budget: 1e12, allocated: 0, votingDeadlineHeight: 0, estTime: 1e9, validWeighted: 3320, paid: 0 }, prov };
    const r = deriveRow(proposal('a', 'x'), new Map([['a', tally('a')]]), new Map(), cycle, GOV_PARAMS.mainnet, 1e9 - 10);
    expect(r.absYes).toBe(380);
    expect(r.threshold?.value).toBe(332);
    expect(r.state).toMatchObject({ passing: true, margin: 48, light: 'pass' });
    const none = deriveRow(proposal('b', 'y'), new Map(), new Map(), null, GOV_PARAMS.mainnet, 0);
    expect(none.state).toBeNull();
    expect(none.schedule).toBeNull();
  });

  it('sorts by rank, unranked last', () => {
    const row = (h: string, rank: number) => deriveRow(proposal(h, h), new Map([[h, tally(h, { rank })]]), new Map(), null, GOV_PARAMS.mainnet, 0);
    expect([row('a', 0), row('b', 2), row('c', 1)].sort(byRank).map((r) => r.p.value.name)).toEqual(['c', 'b', 'a']);
  });

  it('links by name unless the name is ambiguous', () => {
    const a = proposal('aa', 'same').value;
    const c = proposal('cc', 'other').value;
    const names = countNames([a, proposal('bb', 'same').value, c]);
    expect(proposalHref(a, names)).toBe('/p/h/aa');
    expect(proposalHref(c, names)).toBe('/p/other');
  });

  it('payment text follows DashCentral wording', () => {
    expect(paymentText(200e8, { total: 5, remaining: 2, oneTime: false })).toBe('200 DASH per month (2 of 5 remaining)');
    expect(paymentText(200e8, { total: 5, remaining: 0, oneTime: false })).toBe('200 DASH per month (ended)');
    expect(paymentText(1e8, { total: 1, remaining: 1, oneTime: true })).toBe('1 DASH one-time');
    expect(paymentText(1e8, null)).toBe('1 DASH per payment');
  });
});
