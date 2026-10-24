import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findPayment, fundingThreshold, hexToBytes, isSuperblockHeight, parseProposalData, parseTransaction, payeeScript, superblockPaymentsLimit,
  superblockSchedule, superblockShareOfBlock, superblocksBetween,
} from '../src/index.ts';

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

describe('superblock schedule (GetNearestSuperblocksHeights, maturity window)', () => {
  it('mainnet: cycle 16616, maturity 1662', () => {
    // 2,558,864 is the last mainnet superblock on 2026-10-24 (getgovernanceinfo: lastsuperblock 2558864, nextsuperblock 2575480)
    expect(superblockSchedule(2_560_773, 'mainnet')).toEqual({ last: 2_558_864, next: 2_575_480, votingDeadline: 2_573_818, inMaturityWindow: false });
    expect(superblockSchedule(2_573_818, 'mainnet').inMaturityWindow).toBe(true);
    expect(superblockSchedule(2_573_817, 'mainnet').inMaturityWindow).toBe(false);
    expect(superblockSchedule(2_558_864, 'mainnet')).toMatchObject({ last: 2_558_864, next: 2_575_480 });
    expect(superblockSchedule(600_000, 'mainnet')).toMatchObject({ last: 0, next: 614_820 + ((16_616 - (614_820 % 16_616)) % 16_616) });
    expect(isSuperblockHeight(2_558_864, 'mainnet')).toBe(true);
    expect(isSuperblockHeight(2_558_865, 'mainnet')).toBe(false);
    expect(superblocksBetween(2_540_000, 2_575_480, 'mainnet')).toEqual([2_542_248, 2_558_864, 2_575_480]);
  });

  it('testnet: cycle 24, maturity 8', () => {
    expect(superblockSchedule(1_578_680, 'testnet')).toEqual({ last: 1_578_672, next: 1_578_696, votingDeadline: 1_578_688, inMaturityWindow: false });
    expect(superblockSchedule(1_578_690, 'testnet').inMaturityWindow).toBe(true);
    expect(isSuperblockHeight(1_578_672, 'testnet')).toBe(true);
  });
});

describe('payments limit (GetPaymentsLimit)', () => {
  it('equals getgovernanceinfo.governancebudget on mainnet (6828.2637816 DASH for 2,575,480, 2026-10-24)', () => {
    expect(superblockPaymentsLimit(2_575_480, 'mainnet')).toBe(682_826_378_160n);
    expect(superblockPaymentsLimit(2_558_864, 'mainnet')).toBe(682_826_378_160n);
    expect(superblockPaymentsLimit(2_558_865, 'mainnet')).toBe(0n);
  });

  it('follows the yearly 1/14 cut and the V20 treasury change', () => {
    // 13 cuts once prevHeight reaches 13 * 210240
    const after = superblockPaymentsLimit(16_616 * 165, 'mainnet'); // 2,741,640 > 2,733,120
    expect(after).toBeLessThan(682_826_378_160n);
    // V20 (1,987,776): fixed base subsidy 5 and a 20% share; before it Core's GPU-era formula with nBits = 1 gives the 5 DASH floor, 10%
    const v20 = superblockShareOfBlock(1, 1_987_776, 'mainnet', true), pre = superblockShareOfBlock(1, 1_987_776, 'mainnet', false);
    expect(v20 - pre * 2n).toBeGreaterThanOrEqual(0n); // S/5 vs S/10 with integer division
    expect(v20 - pre * 2n).toBeLessThanOrEqual(1n);
    // no treasury share before nBudgetPaymentsStartBlock
    expect(superblockShareOfBlock(1, 328_008, 'mainnet', false)).toBe(0n);
  });

  it('testnet uses powLimit as nBits (min-difficulty network)', () => {
    expect(superblockPaymentsLimit(1_578_696, 'testnet')).toBe(1_428_625_704n);
    // before V20 on testnet the difficulty formula gives the GPU-era cap of 25 DASH base
    // (25 DASH base / 10) vs (5 DASH base / 5): 2.5x, up to integer rounding
    const pre = superblockShareOfBlock(0x1e0fffff, 900_000, 'testnet', false), post = superblockShareOfBlock(0x1e0fffff, 900_000, 'testnet', true);
    expect(pre * 2n - post * 5n).toBeGreaterThanOrEqual(-5n);
    expect(pre * 2n - post * 5n).toBeLessThanOrEqual(5n);
  });
});

describe('funding threshold', () => {
  it('max(nGovernanceMinQuorum, validWeighted / 10)', () => {
    expect(fundingThreshold(3_324, 'mainnet')).toBe(332); // getgovernanceinfo.fundingthreshold on 2026-10-24
    expect(fundingThreshold(50, 'mainnet')).toBe(10);
    expect(fundingThreshold(5, 'testnet')).toBe(1);
  });
});

describe('superblock payments in a real coinbase', () => {
  const sb = load('superblock-mainnet.json');
  const tx = parseTransaction(hexToBytes(sb.coinbaseHex));
  const proposals = load('mainnet-proposals.json').proposals as Array<{ dataHex: string }>;

  it('finds the six payments of superblock 2,558,864, totalling what the bridge recorded as paid', () => {
    let total = 0n;
    const paid: string[] = [];
    for (const p of proposals) {
      const f = parseProposalData(p.dataHex).fields!;
      const amount = BigInt(Math.round(f.paymentAmount * 1e8));
      if (findPayment(tx.vout, f.paymentAddress, amount, 'mainnet') >= 0) { paid.push(f.name); total += amount; }
    }
    expect(paid.length).toBe(6);
    expect(total).toBe(539_300_000_000n);
    expect(paid).toContain('DCG-Operations-Aug-Nov-26');
  });

  it('needs the exact amount and script; P2SH payees work', () => {
    const p2sh = tx.vout.find((o) => o.script[0] === 0xa9)!;
    const f = proposals.map((p) => parseProposalData(p.dataHex).fields!).find((x) => payeeScript(x.paymentAddress, 'mainnet')?.[0] === 0xa9 && findPayment([p2sh], x.paymentAddress, p2sh.value, 'mainnet') === 0);
    expect(f).toBeDefined();
    expect(findPayment(tx.vout, f!.paymentAddress, p2sh.value + 1n, 'mainnet')).toBe(-1);
    expect(findPayment(tx.vout, f!.paymentAddress, p2sh.value, 'testnet')).toBe(-1); // not a testnet address
    expect(findPayment(load('superblock-testnet.json') && tx.vout.slice(0, 2), f!.paymentAddress, p2sh.value, 'mainnet')).toBe(-1);
  });
});
