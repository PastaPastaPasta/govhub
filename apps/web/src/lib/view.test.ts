import { describe, expect, it } from 'vitest';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { paymentText } from '../ui/ProposalCard.tsx';
import { GOV_PARAMS, parseGovParams } from './governance.ts';
import { byRank, countNames, deriveRow, pickTally, proposalHref, weakest } from './view.ts';

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

  it("sorts in Core's funding order (net yes, then hash desc), no tally last", () => {
    const row = (h: string, yes?: number) => deriveRow(proposal(h, h), yes === undefined ? new Map() : new Map([[h, tally(h, { yesWeighted: yes, rank: 99 })]]), new Map(), null, GOV_PARAMS.mainnet, 0);
    expect([row('a'), row('b', 100), row('c', 300), row('d', 100)].sort(byRank).map((r) => r.p.value.name)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('flags published fields that differ from the hashed data', async () => {
    const { loadFixtures } = await import('../data/fixtures.ts');
    const real = (await loadFixtures()).proposals[0]!;
    const ok = deriveRow({ value: real, prov }, new Map(), new Map(), null, GOV_PARAMS.mainnet, 0);
    expect(ok.content.ok).toBe(true);
    const lie = deriveRow({ value: { ...real, url: 'https://phish.example' }, prov }, new Map(), new Map(), null, GOV_PARAMS.mainnet, 0);
    expect(lie.content.ok).toBe(false);
    expect(lie.content.problem).toContain('url');
  });

  it('weakest provenance wins', () => {
    expect(weakest({ kind: 'proof', source: 'a' }, { kind: 'reported', source: 'b' }).source).toBe('b');
    expect(weakest({ kind: 'mismatch', source: 'a' }, { kind: 'verified', source: 'b' }).source).toBe('a');
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

describe('view model with testnet parameters', () => {
  // getgovernanceinfo as the bridge relays it in /v1/cycle (mainnet sample from gov-bridge.dashhq.org; testnet per chainparams.cpp:382-384).
  const MAINNET_INFO = { governanceminquorum: 10, proposalfee: 1, superblockcycle: 16616, superblockmaturitywindow: 1662, lastsuperblock: 2558864, nextsuperblock: 2575480, fundingthreshold: 332 };
  const TESTNET_INFO = { governanceminquorum: 1, proposalfee: 1, superblockcycle: 24, superblockmaturitywindow: 8, lastsuperblock: 1577976, nextsuperblock: 1578000, fundingthreshold: 3 };
  const T = parseGovParams(TESTNET_INFO)!;

  it('parses getgovernanceinfo into the same parameters as Core chainparams', () => {
    expect(parseGovParams(MAINNET_INFO)).toEqual(GOV_PARAMS.mainnet);
    expect(T).toEqual(GOV_PARAMS.testnet);
    expect(parseGovParams({ superblockcycle: 24 })).toBeNull();
    expect(parseGovParams({ ...TESTNET_INFO, superblockmaturitywindow: 30 })).toBeNull();
    expect(parseGovParams(null)).toBeNull();
  });

  it('testnet: hourly superblocks, min quorum 1, payments counted per 24-block cycle', () => {
    const now = 1_800_000_000;
    const sbPeriod = 24 * T.blockSeconds; // ~63 minutes
    const cycle = { value: { superblockHeight: 1578000, budget: 1e12, allocated: 0, votingDeadlineHeight: 1578000 - 8, estTime: now + 600, validWeighted: 7, paid: 0 }, prov };
    // A one-day proposal that started an hour ago.
    const p = proposal('a', 'day');
    p.value.startEpoch = now - 3600;
    p.value.endEpoch = now + 86400 - 3600;
    const r = deriveRow(p, new Map([['a', tally('a', { yesWeighted: 3, noWeighted: 1 })]]), new Map(), cycle, T, now);
    expect(r.threshold?.value).toBe(1); // max(1, floor(7 / 10))
    expect(r.state).toMatchObject({ passing: true, margin: 1 });
    // Superblocks k (relative to the next one) whose time falls in [start - 2h, end + 2h]; those after now are still to come.
    const ks: number[] = [];
    for (let k = -10; k < 40; k++) {
      const t = cycle.value.estTime + k * sbPeriod;
      if (t >= p.value.startEpoch - 7200 && t <= p.value.endEpoch + 7200) ks.push(k);
    }
    const future = ks.filter((k) => cycle.value.estTime + k * sbPeriod > now).length;
    expect(r.schedule).toEqual({ total: ks.length, remaining: future, oneTime: false });
    expect(r.schedule!.total).toBeGreaterThan(20);
    expect(r.schedule!.total).toBeLessThan(30);
    // The same proposal under mainnet rules is one payment: the parameters must follow the data's network.
    expect(deriveRow(p, new Map(), new Map(), cycle, GOV_PARAMS.mainnet, now).schedule).toMatchObject({ total: 1, remaining: 1, oneTime: true });
  });

  it('mainnet proposals under testnet rules give absurd counts (the reported bug): profiles never mix them', () => {
    const now = 1_792_807_235;
    const cycle = { value: { superblockHeight: 2575480, budget: 1e12, allocated: 0, votingDeadlineHeight: 2573818, estTime: 1795180092, validWeighted: 3324, paid: 0 }, prov };
    const p = proposal('a', 'six-months');
    p.value.startEpoch = now - 90 * 86400;
    p.value.endEpoch = now + 90 * 86400;
    const right = deriveRow(p, new Map(), new Map(), cycle, GOV_PARAMS.mainnet, now).schedule!;
    expect(right.total).toBeLessThanOrEqual(7);
    const wrong = deriveRow(p, new Map(), new Map(), cycle, GOV_PARAMS.testnet, now).schedule!;
    expect(wrong.total).toBeGreaterThan(1000);
  });
});

