// The new-proposal path: the serializer and gov hash against real mainnet objects, Core's payment-amount parser, the
// superblock-aligned schedule and the combined check the wizard runs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildProposalDataHex, checkCollateralTx, checkNewProposal, collateralScript, dashToDuffs, duffsToDash, governanceObjectHash, gobjectPrepareCommand, gobjectSubmitCommand,
  hexToBytes, isCollateralChangeAddress, lockProposal, parsePaymentAmount, parseProposalData, paymentAmountNumber, proposalSchedule, Reader, superblockPaymentsLimit,
  upcomingSuperblocks, validateProposalData, GOVERNANCE_FUDGE_WINDOW_S, SUPERBLOCK_EST_BLOCK_SECONDS,
} from '../src/index.ts';

// services/bridge/test/fixtures/mainnet-objects.json: 28 raw governance objects as mainnet Core serialized them (ZMQ rawgovernanceobject).
const objects = JSON.parse(readFileSync(new URL('../../../services/bridge/test/fixtures/mainnet-objects.json', import.meta.url), 'utf8')).objects as Array<{ hash: string; type: number; rawHex: string }>;

/** CGovernanceObject serialization: hashParent, revision, time, collateralHash, vchData, type, masternodeOutpoint, vchSig. */
function decodeObject(rawHex: string) {
  const r = new Reader(hexToBytes(rawHex));
  const parent = r.bytes(32);
  const revision = r.i32();
  const time = Number(r.i64());
  const collateral = r.bytes(32);
  const data = r.bytes(r.compactSize());
  return { parentZero: parent.every((b) => b === 0), revision, time, collateral, dataHex: Buffer.from(data).toString('hex') };
}

describe(`serializer and gov hash against ${objects.length} mainnet governance objects`, () => {
  const proposals = objects.filter((o) => o.type === 1).map((o) => ({ hash: o.hash, ...decodeObject(o.rawHex) }));
  it('the fixture has proposals', () => expect(proposals.length).toBeGreaterThanOrEqual(20));

  for (const p of proposals) {
    it(`${p.hash.slice(0, 12)}: governanceObjectHash equals mainnet Core's hash`, () => {
      expect(p.parentZero).toBe(true);
      expect(governanceObjectHash({ parentHash: '0', revision: p.revision, time: p.time, dataHex: p.dataHex }).display).toBe(p.hash);
    });
  }

  it("re-serializing proposal.dash.org/DashCentral-made objects gives Core's exact bytes and hash", () => {
    let same = 0;
    for (const p of proposals) {
      const f = parseProposalData(p.dataHex).fields!;
      const again = buildProposalDataHex(f);
      if (again !== p.dataHex) continue; // made by another tool (other key order or spacing): still valid, just not our form
      same++;
      expect(lockProposal(again, p.time).govHash).toBe(p.hash);
      expect(validateProposalData(again, 'mainnet').valid).toBe(true);
    }
    // the generator the wizard replaces wrote sorted, compact JSON: most live proposals round-trip byte for byte
    expect(same).toBeGreaterThanOrEqual(Math.ceil(proposals.length / 2));
  });

  it('every mainnet amount is one Core pays exactly', () => {
    for (const p of proposals) {
      const text = /"payment_amount":([^,}]+)/.exec(Buffer.from(p.dataHex, 'hex').toString())![1]!;
      const duffs = parsePaymentAmount(text);
      expect(duffs, text).not.toBeNull();
      expect(paymentAmountNumber(duffs!).payable).toBe(true);
    }
  });
});

describe("ParsePaymentAmount (superblock.cpp:22-63)", () => {
  it.each([
    ['1', 100_000_000n], ['0.1', 10_000_000n], ['12.34567891', 1_234_567_891n], ['12.345678912', null], ['1.00000000', 100_000_000n], ['1.000000000', 100_000_000n],
    ['0.00000001', 1n], ['21000000', 2_100_000_000_000_000n], ['21000000.00000001', null], ['1e5', null], ['.5', null], ['1.', null],
    ['01', null], ['-1', null], ['1.2.3', null], ['', null], ['123456789012345678901', null], [' 1', null], ['0', 0n],
  ])('%s', (text, want) => expect(parsePaymentAmount(text)).toBe(want));

  it('JSON numbers: plain decimals round-trip, amounts below 1e-6 do not (exponent)', () => {
    expect(paymentAmountNumber(123_456_789n)).toEqual({ value: 1.23456789, text: '1.23456789', payable: true });
    expect(paymentAmountNumber(100n).payable).toBe(true); // 0.000001
    expect(paymentAmountNumber(10n).payable).toBe(false); // 1e-7: exponent
    expect(paymentAmountNumber(2_099_999_999_999_999n).payable).toBe(true); // every amount up to MAX_MONEY round-trips (3e6 random samples)
    expect(paymentAmountNumber(0n).payable).toBe(false);
  });

  it('wizard input', () => {
    expect(dashToDuffs('12.5')).toBe(1_250_000_000n);
    expect(dashToDuffs('.5')).toBe(50_000_000n);
    expect(dashToDuffs('1.123456789')).toBeNull();
    expect(dashToDuffs('1.123456780')).toBe(112_345_678n);
    expect(dashToDuffs('1,5')).toBeNull();
    expect(dashToDuffs('')).toBeNull();
    expect(duffsToDash(1_250_000_000n)).toBe('12.5');
    expect(duffsToDash(1n)).toBe('0.00000001');
    expect(duffsToDash(100_000_000n)).toBe('1');
  });
});

describe('schedule', () => {
  // mainnet, 2026-10-24: tip 2,560,773, next superblock 2,575,480 (getgovernanceinfo)
  const now = 1_792_800_000;
  it('mainnet: midpoints around the chosen superblocks; Core pays exactly those', () => {
    const s = proposalSchedule({ network: 'mainnet', tipHeight: 2_560_773, now, firstSuperblock: 2_575_480, payments: 3 });
    expect(s.superblocks.map((x) => x.height)).toEqual([2_575_480, 2_592_096, 2_608_712]);
    const est = (h: number) => Math.floor(now + (h - 2_560_773) * SUPERBLOCK_EST_BLOCK_SECONDS);
    expect(s.startEpoch).toBe(est(2_575_480 - 8308));
    expect(s.endEpoch).toBe(est(2_608_712 + 8308));
    expect(s.eligible).toEqual([2_575_480, 2_592_096, 2_608_712]);
    for (const sb of s.superblocks) {
      expect(sb.estTime).toBeGreaterThan(s.startEpoch + GOVERNANCE_FUDGE_WINDOW_S);
      expect(sb.estTime).toBeLessThan(s.endEpoch - GOVERNANCE_FUDGE_WINDOW_S);
      expect(sb.votingDeadline).toBe(sb.height - 1662);
      expect(sb.budgetLimit).toBe(superblockPaymentsLimit(sb.height, 'mainnet'));
    }
    // blocks 3% faster or slower over the whole window still pay exactly these three
    for (const bs of [SUPERBLOCK_EST_BLOCK_SECONDS * 0.97, SUPERBLOCK_EST_BLOCK_SECONDS * 1.03]) {
      const real = (h: number) => now + (h - 2_560_773) * bs;
      const paid = [2_558_864, 2_575_480, 2_592_096, 2_608_712, 2_625_328].filter((h) => real(h) >= s.startEpoch - GOVERNANCE_FUDGE_WINDOW_S && real(h) <= s.endEpoch + GOVERNANCE_FUDGE_WINDOW_S);
      expect(paid).toEqual([2_575_480, 2_592_096, 2_608_712]);
    }
  });

  it('testnet: hourly superblocks and a 2-hour margin, so Core may pay more often than planned (shown as `eligible`)', () => {
    const s = proposalSchedule({ network: 'testnet', tipHeight: 1_578_680, now, firstSuperblock: 1_578_696, payments: 1 });
    expect(s.superblocks).toHaveLength(1);
    expect(s.eligible.length).toBeGreaterThan(1);
    expect(s.eligible).toContain(1_578_696);
  });

  it('refuses a height that is not a superblock, or no payments', () => {
    expect(() => proposalSchedule({ network: 'mainnet', tipHeight: 1, now, firstSuperblock: 2_575_481, payments: 1 })).toThrow();
    expect(() => proposalSchedule({ network: 'mainnet', tipHeight: 1, now, firstSuperblock: 2_575_480, payments: 0 })).toThrow();
  });

  it('first-payment options close when the voting deadline is too near', () => {
    const open = upcomingSuperblocks('mainnet', 2_560_773, now, 3);
    expect(open.map((o) => [o.height, o.state])).toEqual([[2_575_480, 'open'], [2_592_096, 'open'], [2_608_712, 'open']]);
    expect(upcomingSuperblocks('mainnet', 2_573_000, now, 1)[0]!.state).toBe('tight'); // 818 blocks (~1.5 days) left
    expect(upcomingSuperblocks('mainnet', 2_573_810, now, 1)[0]!.state).toBe('closed');
    expect(upcomingSuperblocks('mainnet', 2_575_480, now, 1)[0]!.height).toBe(2_592_096); // a superblock at the tip is past
    const t = upcomingSuperblocks('testnet', 1_578_680, now, 2);
    expect(t.map((o) => [o.height, o.state])).toEqual([[1_578_696, 'closed'], [1_578_720, 'open']]);
  });
});

describe('checkNewProposal', () => {
  const now = 1_792_800_000;
  const base = {
    network: 'mainnet' as const,
    name: 'govhub-wizard-test',
    paymentAddress: 'XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62',
    paymentDuffs: 1_250_000_000n,
    url: 'https://gov.dashhq.org/p/FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh/govhub-wizard-test',
    startEpoch: now,
    endEpoch: now + 30 * 86400,
    now,
  };

  it('a valid proposal: exact bytes, under 512, valid for Core', () => {
    const c = checkNewProposal(base);
    expect(c.errors).toEqual([]);
    expect(validateProposalData(c.dataHex!, 'mainnet', { now }).valid).toBe(true);
    expect(c.dataBytes).toBeLessThanOrEqual(512);
    expect(Buffer.from(c.dataHex!, 'hex').toString()).toBe(
      `{"end_epoch":${now + 30 * 86400},"name":"govhub-wizard-test","payment_address":"XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62","payment_amount":12.5,"start_epoch":${now},"type":1,"url":"https://gov.dashhq.org/p/FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh/govhub-wizard-test"}`,
    );
  });

  it.each([
    [{ name: 'Has Space' }, 'name'],
    [{ name: 'x'.repeat(41) }, 'name'],
    [{ name: '' }, 'name'],
    [{ name: 'émoji' }, 'name'],
    [{ paymentAddress: 'yXGeNPQXYFXhLAN1ZKrAjxzzBnZ2JZNKnh' }, 'paymentAddress'], // a testnet address on mainnet
    [{ paymentAddress: 'Xd Wk' }, 'paymentAddress'],
    [{ paymentDuffs: 0n }, 'paymentAmount'],
    [{ paymentDuffs: 10n }, 'paymentAmount'],
    [{ url: 'abc' }, 'url'],
    [{ url: 'https://x.org/a b' }, 'url'],
    [{ url: 'https://[::1/x' }, 'url'],
    [{ endEpoch: now - 1, startEpoch: now - 100 }, 'schedule'],
    [{ endEpoch: now, startEpoch: now }, 'schedule'],
    [{ url: `https://example.org/${'a'.repeat(400)}` }, 'data'],
  ] as const)('%o -> %s', (patch, field) => {
    const c = checkNewProposal({ ...base, ...patch });
    expect(c.errors.map((e) => e.field)).toContain(field);
    expect(c.dataHex).toBeUndefined();
  });

  it('upper case names are Core-valid (ToLower first); P2SH payouts are allowed', () => {
    expect(checkNewProposal({ ...base, name: 'Govhub-Test_1' }).errors).toEqual([]);
    expect(checkNewProposal({ ...base, paymentAddress: '7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh' }).errors).toEqual([]);
  });

  it('an amount above a planned superblock\'s whole budget can never be paid', () => {
    const c = checkNewProposal({ ...base, paymentDuffs: 10_000_000_000_000n, superblocks: [{ height: 2_575_480, budgetLimit: superblockPaymentsLimit(2_575_480, 'mainnet') }] });
    expect(c.errors[0]).toMatchObject({ field: 'paymentAmount', rule: 'payment' });
  });

  it('lock: the hash Core will compute, the OP_RETURN, the two Core commands', () => {
    const c = checkNewProposal(base);
    const l = lockProposal(c.dataHex!, now);
    const h = governanceObjectHash({ parentHash: '0', revision: 1, time: now, dataHex: c.dataHex! });
    expect(l.govHash).toBe(h.display);
    expect(hexToBytes(l.govHashRaw)).toEqual(h.raw);
    expect(Buffer.from(collateralScript(hexToBytes(l.govHashRaw))).toString('hex')).toBe(`6a20${l.govHashRaw}`);
    expect(gobjectPrepareCommand(l)).toBe(`gobject prepare 0 1 ${now} ${c.dataHex}`);
    expect(gobjectSubmitCommand(l, 'ab'.repeat(32))).toBe(`gobject submit 0 1 ${now} ${c.dataHex} ${'ab'.repeat(32)}`);
    expect(() => lockProposal(c.dataHex!, 0)).toThrow();
    expect(checkCollateralTx).toBeTypeOf('function');
  });

  it('collateral change must be P2PKH', () => {
    expect(isCollateralChangeAddress('XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62', 'mainnet')).toBe(true);
    expect(isCollateralChangeAddress('7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh', 'mainnet')).toBe(false);
    expect(isCollateralChangeAddress('XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62', 'testnet')).toBe(false);
  });
});
