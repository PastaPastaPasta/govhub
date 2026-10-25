// Browser-paid proposal collateral: the deposit-key derivation recovery tools rely on, the collateral transaction (OP_RETURN, burn,
// fee, change, dust, P2PKH-only outputs) and the runner (watch before showing the address, only confirmed payments spent, the signed
// collateral saved before its broadcast, resume without a second collateral, refused inputs).
import { parseTx, type Dapi, type WatchHandlers } from '@govhub/dapi';
import { checkCollateralTx, collateralScript, decodeAddress, encodeAddress, GOVERNANCE_PROPOSAL_FEE_DUFFS, governanceObjectHash, p2pkhAddress } from '@govhub/verify';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hash160, hexToBytes } from '../src/bytes.ts';
import { addressOf, publicKeyOf } from '../src/keys.ts';
import {
  collateralFeeDuffs, MIN_COLLATERAL_DEPOSIT_DUFFS, newCollateralFunding, pickCollateralInputs, proposalDepositKey, proposalDepositKeys, proposalDepositPath, runCollateralFunding,
  sessionProposalDepositKey, type CollateralFundingRecord, type CollateralFundingView,
} from '../src/proposal.ts';
import { SeedWallet } from '../src/seed.ts';
import { buildPayment, buildProposalCollateral, DUST_DUFFS, p2pkhScript } from '../src/tx.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const IDENTITY = 'FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh';
const gov = governanceObjectHash({ parentHash: '0', revision: 1, time: 1_792_800_000, dataHex: Buffer.from('{"type":1}').toString('hex') });
const govRawHex = bytesToHex(gov.raw);
const payer = hexToBytes('11'.repeat(32));
const refundKey = hexToBytes('22'.repeat(32));
const refundAddress = addressOf(publicKeyOf(refundKey), 'testnet');
const P2SH_TESTNET = encodeAddress('p2sh', new Uint8Array(20).fill(7), 'testnet');

describe('deposit key derivation', () => {
  it("seed: m/9'/coin'/100'/0'/index, last index not hardened like DIP-13 funding keys (pinned: a change breaks every recovery scan)", () => {
    expect(proposalDepositPath('mainnet', 0)).toBe("m/9'/5'/100'/0'/0");
    expect(proposalDepositPath('testnet', 7)).toBe("m/9'/1'/100'/0'/7");
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const k0 = proposalDepositKey({ kind: 'seed', index: 0 }, { wallet: w }, 'testnet');
    expect(k0.publicKey).toEqual(w.derive("m/9'/1'/100'/0'/0").publicKey);
    expect(addressOf(k0.publicKey, 'testnet')).toMatchInlineSnapshot(`"ygtRiscCdoMiLCL7ewPBYsMqLQJHmEJHvf"`);
    const k1 = proposalDepositKey({ kind: 'seed', index: 1 }, { wallet: w }, 'testnet');
    expect(k1.publicKey).not.toEqual(k0.publicKey);
    expect(() => proposalDepositKey({ kind: 'seed', index: 0 }, { wallet: w }, 'mainnet')).toThrow(/network/);
    expect(() => proposalDepositKey({ kind: 'seed', index: 0 }, {}, 'testnet')).toThrow(/recovery phrase/);
  });

  it('key sign-in: HMAC of the identity key, per identity and index; a wiped key is refused', () => {
    const sk = hexToBytes('33'.repeat(32));
    const a = sessionProposalDepositKey(sk, IDENTITY, 0);
    expect(sessionProposalDepositKey(sk, IDENTITY, 0).privateKey).toEqual(a.privateKey);
    expect(sessionProposalDepositKey(sk, IDENTITY, 1).privateKey).not.toEqual(a.privateKey);
    expect(sessionProposalDepositKey(sk, 'N3kw2XPJiZyiSjyQN8eNTodoqDCr9krV72NDAn2ADVF', 0).privateKey).not.toEqual(a.privateKey);
    expect(bytesToHex(a.publicKey)).toMatchInlineSnapshot(`"032fd34e65fcccdd198907fcf702766c9685296d713eef4ac714b436e2a752e7b1"`);
    expect(() => sessionProposalDepositKey(new Uint8Array(32), IDENTITY, 0)).toThrow(/Sign in again/);
    expect(proposalDepositKey({ kind: 'session', index: 0, identityId: IDENTITY }, { sessionKey: sk }, 'testnet').privateKey).toEqual(a.privateKey);
    expect(() => proposalDepositKey({ kind: 'session', index: 0, identityId: IDENTITY }, {}, 'testnet')).toThrow(/signed-in key/);
  });

  it('scanner list: public data only, one entry per index', () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const list = proposalDepositKeys({ wallet: w }, 'testnet', 0, 3);
    expect(list.map((x) => x.source)).toEqual([{ kind: 'seed', index: 0 }, { kind: 'seed', index: 1 }, { kind: 'seed', index: 2 }]);
    expect(list[0]!.address).toBe(addressOf(proposalDepositKey({ kind: 'seed', index: 0 }, { wallet: w }, 'testnet').publicKey, 'testnet'));
    expect(JSON.stringify(list)).not.toMatch(/privateKey/);
    expect(() => proposalDepositKeys({ sessionKey: hexToBytes('33'.repeat(32)) }, 'testnet')).toThrow(/identity id/);
  });
});

describe('collateral transaction', () => {
  const key = hexToBytes('44'.repeat(32));
  const utxo = (value: bigint, n = 0) => ({ txid: `${n}`.padStart(64, 'a'), vout: n, value });

  it('OP_RETURN <raw hash> worth 1 DASH, change to the refund address, fee = size at 1 duff/byte; Core would accept it', () => {
    const b = buildProposalCollateral({ utxos: [utxo(150_000_000n)], key, govHashRaw: gov.raw, changeScript: p2pkhScript(hash160(publicKeyOf(refundKey))) });
    const tx = parseTx(b.raw);
    expect(tx.outputs).toHaveLength(2);
    expect(bytesToHex(tx.outputs[0]!.script)).toBe(`6a20${govRawHex}`);
    expect(tx.outputs[0]!.value).toBe(GOVERNANCE_PROPOSAL_FEE_DUFFS);
    expect(p2pkhAddress(tx.outputs[1]!.script.slice(3, 23), 'testnet')).toBe(refundAddress);
    expect(b.feeDuffs).toBe(collateralFeeDuffs(1));
    expect(b.feeDuffs).toBeGreaterThanOrEqual(BigInt(b.raw.length)); // >= 1 duff per real byte
    expect(tx.outputs[1]!.value).toBe(150_000_000n - GOVERNANCE_PROPOSAL_FEE_DUFFS - b.feeDuffs);
    expect(checkCollateralTx(b.raw, gov.raw, { expectedTxid: b.txid }).valid).toBe(true);
    // the reversed (display) hash is NOT what Core looks for
    expect(checkCollateralTx(b.raw, gov.raw.slice().reverse()).valid).toBe(false);
  });

  it('change below dust goes to the fee: no output Core would call dust', () => {
    const exact = GOVERNANCE_PROPOSAL_FEE_DUFFS + collateralFeeDuffs(1) + DUST_DUFFS - 1n;
    const b = buildProposalCollateral({ utxos: [utxo(exact)], key, govHashRaw: gov.raw });
    expect(parseTx(b.raw).outputs).toHaveLength(1);
    expect(b.changeVout).toBeNull();
    expect(b.feeDuffs).toBe(exact - GOVERNANCE_PROPOSAL_FEE_DUFFS);
    const ok = buildProposalCollateral({ utxos: [utxo(exact + 1n)], key, govHashRaw: gov.raw });
    expect(ok.changeDuffs).toBe(DUST_DUFFS);
  });

  it('several inputs; refuses P2SH change, too little money, a short hash, a burn under 1 DASH', () => {
    const b = buildProposalCollateral({ utxos: [utxo(60_000_000n, 1), utxo(60_000_000n, 2)], key, govHashRaw: gov.raw });
    expect(parseTx(b.raw).inputs).toHaveLength(2);
    expect(b.feeDuffs).toBe(collateralFeeDuffs(2));
    const p2sh = Uint8Array.from([0xa9, 0x14, ...new Uint8Array(20), 0x87]);
    expect(() => buildProposalCollateral({ utxos: [utxo(200_000_000n)], key, govHashRaw: gov.raw, changeScript: p2sh })).toThrow(/P2PKH/);
    expect(() => buildProposalCollateral({ utxos: [utxo(100_000_100n)], key, govHashRaw: gov.raw })).toThrow(/insufficient/);
    expect(() => buildProposalCollateral({ utxos: [utxo(200_000_000n)], key, govHashRaw: gov.raw.slice(0, 31) })).toThrow(/32 bytes/);
    expect(() => buildProposalCollateral({ utxos: [utxo(200_000_000n)], key, govHashRaw: gov.raw, burnDuffs: 99_999_999n })).toThrow(/1 DASH/);
    expect(collateralScript(gov.raw)).toEqual(parseTx(b.raw).outputs[0]!.script);
  });

  it('input picking: confirmed only, covers burn + fee, everything usable is spent', () => {
    const d = (value: number, confirmed = true, n = 0) => ({ txid: `${n}`.padStart(64, 'b'), vout: 0, value: String(value), confirmed });
    expect(pickCollateralInputs([d(200_000_000, false)])).toBeNull();
    expect(pickCollateralInputs([d(100_000_000)])).toBeNull();
    expect(pickCollateralInputs([d(60_000_000, true, 1), d(50_000_000, true, 2), d(100, true, 3)])!.map((x) => x.txid.slice(-1))).toEqual(['1', '2']);
    expect(MIN_COLLATERAL_DEPOSIT_DUFFS).toBe(100_000_000n + 1000n);
  });
});

// ---- runner ----

function fakeDapi(o: { known?: Set<string>; refuse?: number } = {}) {
  const events: string[] = [];
  const deposits: WatchHandlers[] = [];
  const known = o.known ?? new Set<string>();
  let refuse = o.refuse ?? 0;
  const dapi = {
    network: 'testnet',
    call: async (fn: (core: unknown) => Promise<unknown>) => ({
      value: await fn({
        getBestBlockHeight: async () => 1000,
        getTransaction: async (txid: string) => {
          if (!known.has(txid)) throw Object.assign(new Error('not found'), { code: 5 });
          return { height: 0, confirmations: 0 };
        },
      }),
      node: 'n',
    }),
    watchAddressForDeposit: async (_h: Uint8Array, h: WatchHandlers) => {
      events.push('watch');
      deposits.push(h);
      return { cancel: () => events.push('cancel') };
    },
    broadcastTransaction: async (raw: Uint8Array) => {
      events.push('broadcast');
      if (refuse > 0) {
        refuse--;
        throw new Error('bad-txns-inputs-missingorspent');
      }
      known.add(parseTx(raw).txid);
      return { txid: parseTx(raw).txid, node: 'n' };
    },
  };
  return {
    dapi: dapi as unknown as Dapi,
    events,
    known,
    pay(value: bigint, to: Uint8Array, o2: { lock?: boolean; n?: number } = {}) {
      const p = buildPayment({ utxos: [{ txid: `${o2.n ?? 0}`.padStart(64, 'c'), vout: 0, value: value + 10_000n }], key: payer, to: [{ pubKeyHash: to, duffs: value }] });
      const tx = parseTx(p.raw);
      deposits.at(-1)!.onTx({ tx, raw: p.raw, matches: [0], node: 'n' });
      if (o2.lock !== false) void deposits.at(-1)!.onIsLock({ lock: { txid: tx.txid } as never, bytes: new Uint8Array(4), known: true, node: 'n' });
      return tx.txid;
    },
    block(txid: string) {
      deposits.at(-1)!.onBlock?.({ matched: [txid] } as never, 'n');
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(f: () => boolean, ms = 4000) {
  for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!f()) throw new Error('timed out');
}

function setup(known?: Set<string>, refuse?: number) {
  const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
  const key = proposalDepositKey({ kind: 'seed', index: 0 }, { wallet: w }, 'testnet');
  const f = fakeDapi({ known, refuse });
  const saved: CollateralFundingRecord[] = [];
  const views: CollateralFundingView[] = [];
  const record = newCollateralFunding({ network: 'testnet', source: { kind: 'seed', index: 0 }, key, govHashRaw: govRawHex, refundAddress });
  const save = (r: CollateralFundingRecord) => {
    f.events.push(r.tx ? 'save-with-tx' : 'save');
    saved.push(structuredClone(r));
  };
  return { key, f, record, save, saved, views, h160: hash160(key.publicKey) };
}

describe('runCollateralFunding', () => {
  it('watches before the address is shown, spends only confirmed payments, saves the signed tx before broadcasting', async () => {
    const s = setup();
    const run = runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: s.key, record: s.record, save: s.save, onUpdate: (v) => s.views.push(v) });
    await until(() => s.views.length > 0);
    expect(s.f.events[0]).toBe('save'); // watchFromHeight
    expect(s.f.events.indexOf('watch')).toBeLessThan(s.f.events.length);
    expect(s.views[0]!.uri).toBe(`dash:${s.record.address}?amount=1.00001`);
    // an unconfirmed payment is never spent
    const t1 = s.f.pay(110_000_000n, s.h160, { lock: false });
    await tick();
    expect(s.f.events).not.toContain('broadcast');
    expect(s.views.at(-1)!.pendingDuffs).toBe(110_000_000n);
    s.f.block(t1);
    const { txid } = await run;
    const iSave = s.f.events.indexOf('save-with-tx');
    expect(iSave).toBeGreaterThan(-1);
    expect(iSave).toBeLessThan(s.f.events.indexOf('broadcast'));
    const rec = s.saved.at(-1)!;
    expect(rec.state).toBe('broadcast');
    expect(rec.tx!.txid).toBe(txid);
    const tx = parseTx(hexToBytes(rec.tx!.raw));
    expect(tx.inputs.map((i) => i.prevTxid)).toEqual([t1]);
    expect(checkCollateralTx(hexToBytes(rec.tx!.raw), gov.raw, { expectedTxid: txid }).valid).toBe(true);
    expect(BigInt(rec.tx!.changeDuffs)).toBe(10_000_000n - collateralFeeDuffs(1));
    // public data only
    expect(JSON.stringify(s.saved)).not.toContain(bytesToHex(s.key.privateKey));
    expect(s.f.events.at(-1)).toBe('cancel');
  });

  it('two payments that together cover it are both spent', async () => {
    const s = setup();
    const run = runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: s.key, record: s.record, save: s.save, onUpdate: (v) => s.views.push(v) });
    await until(() => s.views.length > 0);
    s.f.pay(60_000_000n, s.h160, { n: 1 });
    await tick();
    expect(s.views.at(-1)!.remainingDuffs).toBeGreaterThan(40_000_000n);
    s.f.pay(60_000_000n, s.h160, { n: 2 });
    await run;
    expect(parseTx(hexToBytes(s.saved.at(-1)!.tx!.raw)).inputs).toHaveLength(2);
  });

  it('resume: a saved collateral is never rebuilt, and not re-sent once a node knows it', async () => {
    const s = setup();
    const run = runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: s.key, record: s.record, save: s.save });
    await until(() => s.f.events.includes('watch'));
    s.f.pay(120_000_000n, s.h160);
    const { txid } = await run;
    const rec = structuredClone(s.saved.at(-1)!);
    // a crash after saving but before the broadcast: the same bytes are sent
    const s2 = setup();
    const before = structuredClone({ ...rec, state: 'building' as const, broadcastAt: undefined });
    const again = await runCollateralFunding({ dapi: s2.f.dapi, network: 'testnet', key: s2.key, record: before, save: s2.save });
    expect(again.txid).toBe(txid);
    expect(s2.f.events.filter((e) => e === 'broadcast')).toHaveLength(1);
    // already known to the network: not sent again
    const s3 = setup(new Set([txid]));
    const third = await runCollateralFunding({ dapi: s3.f.dapi, network: 'testnet', key: s3.key, record: structuredClone(rec), save: s3.save });
    expect(third.txid).toBe(txid);
    expect(s3.f.events).not.toContain('broadcast');
  });

  it('inputs refused three times with the collateral unknown: forgotten and rebuilt from new payments', async () => {
    const s = setup(undefined, 3);
    const run = runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: s.key, record: s.record, save: s.save, onUpdate: (v) => s.views.push(v) });
    await until(() => s.f.events.includes('watch'));
    s.f.pay(120_000_000n, s.h160, { n: 1 });
    await until(() => s.views.some((v) => v.note?.includes('rejected')), 20_000);
    expect(s.record.rejected).toHaveLength(1);
    expect(s.record.tx).toBeUndefined();
    s.f.pay(130_000_000n, s.h160, { n: 2 });
    const { txid } = await run;
    expect(s.record.rejected![0]).not.toBe(txid);
  }, 30_000);

  it('a guard reason stops before anything is built: the payment stays at the deposit address', async () => {
    const s = setup();
    const run = runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: s.key, record: s.record, save: s.save, guard: () => 'the proposal has expired.' });
    await until(() => s.f.events.includes('watch'));
    s.f.pay(120_000_000n, s.h160);
    await expect(run).rejects.toThrow(/expired.*still at/);
    expect(s.record.tx).toBeUndefined();
    expect(s.f.events).not.toContain('broadcast');
  });

  it('input order does not depend on arrival order', () => {
    const d = (txid: string, vout: number, value: string) => ({ txid, vout, value, confirmed: true });
    const a = [d('bb'.repeat(32), 1, '60000000'), d('aa'.repeat(32), 0, '60000000'), d('cc'.repeat(32), 0, '70000000')];
    expect(pickCollateralInputs(a)).toEqual(pickCollateralInputs([...a].reverse()));
    expect(pickCollateralInputs(a)!.map((x) => x.txid.slice(0, 2))).toEqual(['cc', 'aa', 'bb']);
  });

  it('refuses another key, a P2SH refund address, a network mismatch', async () => {
    const s = setup();
    const other = proposalDepositKey({ kind: 'seed', index: 1 }, { wallet: SeedWallet.fromPhrase(PHRASE, 'testnet') }, 'testnet');
    await expect(runCollateralFunding({ dapi: s.f.dapi, network: 'testnet', key: other, record: s.record, save: s.save })).rejects.toThrow(/another deposit key/);
    expect(() => newCollateralFunding({ network: 'testnet', source: { kind: 'seed', index: 0 }, key: s.key, govHashRaw: govRawHex, refundAddress: P2SH_TESTNET })).toThrow(/P2PKH/);
    expect(decodeAddress(P2SH_TESTNET, 'testnet')?.type).toBe('p2sh');
    await expect(runCollateralFunding({ dapi: s.f.dapi, network: 'mainnet', key: s.key, record: s.record, save: s.save })).rejects.toThrow(/network mismatch/);
  });
});
