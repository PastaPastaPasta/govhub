// The wizard's payment count must match the count the proposal page shows once the proposal is live (both follow Dash Core's rule:
// a superblock pays a proposal when its estimated time is within 2 hours of [start_epoch, end_epoch]).
import { proposalSchedule } from '@govhub/verify';
import { describe, expect, it } from 'vitest';
import { GOV_PARAMS, paymentSchedule } from '../lib/governance.ts';
import { paymentCounts, paymentTotalText } from './draft.ts';

const BLOCK_S = GOV_PARAMS.testnet.blockSeconds;

describe('payment count', () => {
  it('testnet: 3 planned payments are up to 7, as the proposal page counts them (aa654150…, 2026-11-17)', () => {
    // the demo proposal: 3 payments of 5 tDASH from superblock 1593552, chosen at tip 1593530
    const tip = 1_593_530;
    const now = 1_794_949_000;
    const s = proposalSchedule({ network: 'testnet', tipHeight: tip, now, firstSuperblock: 1_593_552, payments: 3 });
    expect(s.superblocks).toHaveLength(3);
    // what the proposal page derives from the published epochs, measured from the cycle of the first payment
    const cycle = { estTime: now + (1_593_552 - tip) * BLOCK_S };
    const page = paymentSchedule({ startEpoch: s.startEpoch, endEpoch: s.endEpoch }, cycle, GOV_PARAMS.testnet, now);
    expect(page.total).toBe(7);
    expect(paymentCounts(s)).toEqual({ planned: 3, max: page.total });
    expect(paymentTotalText(500_000_000n, s, 'tDASH')).toBe('5 tDASH × up to 7 = up to 35 tDASH');
  });

  it('mainnet: the planned payments are all Core can pay', () => {
    const s = proposalSchedule({ network: 'mainnet', tipHeight: 2_380_000, now: 1_794_949_000, firstSuperblock: 2392704, payments: 3 });
    expect(paymentCounts(s)).toEqual({ planned: 3, max: 3 });
    expect(paymentTotalText(500_000_000n, s, 'DASH')).toBe('5 DASH × 3 = 15 DASH');
  });
});
