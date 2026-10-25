import { describe, expect, it } from 'vitest';
import { displayEpochsAt, displayWindow, EPOCH_PARAMS, epochLength, epochOf, epochStart, extraPostingWindow, issuanceWindow, issuingEpochsAt, keyDeadline, postingWindow, privateRequestWindow, reportWindow } from '../src/epoch.ts';
import { clientPostingWindow, pickHeight, pickPostHeight, pickRequestHeight, requestableEpoch } from '../src/schedule.ts';

const M = EPOCH_PARAMS.mainnet;
const T = EPOCH_PARAMS.testnet;

describe('epochs', () => {
  it('mainnet: one superblock cycle; S(E) are superblock heights', () => {
    expect(epochLength(M)).toBe(16616);
    // mainnet superblock 2,558,864 (getgovernanceinfo lastsuperblock, 2026-10-24) is S(154)
    expect(epochStart(M, 154)).toBe(2558864);
    expect(epochOf(M, 2558864)).toBe(154);
    expect(epochOf(M, 2558863)).toBe(153);
    expect(epochStart(M, 155)).toBe(2575480); // nextsuperblock
  });
  it('testnet: 24 cycles of 24 blocks', () => {
    expect(epochLength(T)).toBe(576);
    expect(epochStart(T, 2741) % 24).toBe(0);
    expect(epochOf(T, 1578655)).toBe(2740);
  });
  it('windows', () => {
    const E = 2742;
    expect(issuanceWindow(T, E)).toEqual({ from: 2741 * 576, to: 2743 * 576 }); // during E-1 and during E
    expect(privateRequestWindow(T, E)).toEqual({ from: 2741 * 576 + 3, to: 2742 * 576 - 3 });
    expect(postingWindow(T, E)).toEqual({ from: 2742 * 576, to: 2742 * 576 + 72 });
    expect(extraPostingWindow(T, E)).toEqual({ from: 2742 * 576, to: 2742 * 576 + 288 });
    expect(displayWindow(T, E)).toEqual({ from: 2742 * 576, to: 2743 * 576 + 72 });
    expect(reportWindow(T, E)).toEqual({ from: 2743 * 576, to: 2743 * 576 + 72 });
    // inside E's issuance window, before the last Standard request for E (clients switch to E+1 there) and before E's report
    expect(keyDeadline(T, E)).toBe(2743 * 576 - 3);
    expect(keyDeadline(T, E)).toBe(privateRequestWindow(T, E + 1).to);
    expect(keyDeadline(T, E)).toBeLessThan(reportWindow(T, E).from);
    expect(issuingEpochsAt(T, 2741 * 576)).toEqual([2741, 2742]);
    expect(issuingEpochsAt(T, 2742 * 576 - 1)).toEqual([2741, 2742]);
  });
  it('display epochs: current, plus the previous during W', () => {
    const s = epochStart(T, 2742);
    expect(displayEpochsAt(T, s)).toEqual([2742, 2741]);
    expect(displayEpochsAt(T, s + 72)).toEqual([2742, 2741]);
    expect(displayEpochsAt(T, s + 73)).toEqual([2742]);
    expect(displayEpochsAt(T, s - 1)).toEqual([2741]);
  });
  it('rejects nonsense', () => {
    expect(() => epochOf(T, -1)).toThrow();
    expect(() => epochOf(T, 1.5)).toThrow();
    expect(() => issuanceWindow(T, 0)).toThrow();
  });
});

describe('scheduling', () => {
  it('pickHeight is uniform over what is left of the range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const h = pickHeight({ from: 100, to: 110 }, 0)!;
      expect(h).toBeGreaterThanOrEqual(100);
      expect(h).toBeLessThan(110);
      seen.add(h);
    }
    expect(seen.size).toBe(10);
    expect(pickHeight({ from: 100, to: 110 }, 108)).toBeGreaterThanOrEqual(108);
    expect(pickHeight({ from: 100, to: 110 }, 110)).toBeNull();
  });
  it('request heights fall inside the client issuance window', () => {
    const E = 2742;
    const w = privateRequestWindow(T, E);
    for (let i = 0; i < 200; i++) {
      const h = pickRequestHeight(T, E, w.from - 50)!;
      expect(h >= w.from && h < w.to).toBe(true);
    }
    expect(pickRequestHeight(T, E, w.to)).toBeNull();
  });
  it('post heights fall inside [S(E)+margin, S(E)+W]', () => {
    const E = 2742;
    const w = clientPostingWindow(T, E);
    for (let i = 0; i < 200; i++) {
      const h = pickPostHeight(T, E, 0);
      expect(h >= epochStart(T, E) + 3 && h <= epochStart(T, E) + 72).toBe(true);
    }
    expect(pickPostHeight(T, E, w.to + 10)).toBe(w.to + 10);
  });
  it('requestable epoch skips a window that is about to close', () => {
    const s = epochStart(T, 2741);
    expect(requestableEpoch(T, s + 10)).toBe(2742);
    expect(requestableEpoch(T, s + 576 - 2)).toBe(2743);
  });
  it('standard mode asks for the current epoch and posts at once, never before S(E)', () => {
    const s = epochStart(T, 2742);
    expect(requestableEpoch(T, s + 10, 'standard')).toBe(2742);
    expect(requestableEpoch(T, s + 576 - 2, 'standard')).toBe(2743); // last margin blocks: the next epoch
    expect(pickPostHeight(T, 2742, s + 10, 'standard')).toBe(s + 10);
    expect(pickPostHeight(T, 2743, s + 575, 'standard')).toBe(s + 576);
  });
  it('extra-private posts spread over the first half of the epoch', () => {
    const w = clientPostingWindow(T, 2742, 'extra');
    for (let i = 0; i < 200; i++) {
      const h = pickPostHeight(T, 2742, 0, 'extra');
      expect(h >= w.from && h < w.to).toBe(true);
    }
    expect(w.to - w.from).toBeGreaterThan(200);
  });
});
