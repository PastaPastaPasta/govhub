import { secp256k1 } from '@noble/curves/secp256k1.js';
import { parseTx } from '@govhub/dapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, hash160, hexToBytes, reversed, sha256d, toBase58, u32le } from '../src/bytes.ts';
import { publicKeyOf } from '../src/keys.ts';
import { AssetLockError, BURN_SCRIPT, buildAssetLock, buildPayment, buildSweep, DUST_DUFFS, estimateSweepFee, identityIdFromOutpoint, locateCredit, p2pkhScript, p2shScript, parseAssetLockPayload } from '../src/tx.ts';

const key = hexToBytes('11'.repeat(32));
const other = hexToBytes('22'.repeat(32));
const h = hash160(publicKeyOf(key));
const utxo = { txid: 'ab'.repeat(32), vout: 1, value: 1_000_000n };

type EvoLike = {
  AssetLockProof: { createChainAssetLockProof(h: number, o: unknown): { createIdentityId(): { toString(): string } } };
  OutPoint: new (txid: string, vout: number) => unknown;
  ensureInitialized(): Promise<void>;
};
let evo: EvoLike;
beforeAll(async () => {
  evo = (await import('@dashevo/evo-sdk')) as unknown as EvoLike;
  await evo.ensureInitialized();
});

/** Legacy sighash recomputed independently from the parsed tx, then the input's DER signature checked against it. */
function checkSignatures(raw: Uint8Array, pub: Uint8Array) {
  const tx = parseTx(raw);
  tx.inputs.forEach((inp, idx) => {
    const s = inp.script;
    const sigLen = s[0]!;
    const der = s.subarray(1, sigLen); // drop the trailing sighash byte
    expect(s[sigLen]).toBe(1);
    expect(bytesToHex(s.subarray(sigLen + 2))).toBe(bytesToHex(pub));
    // rebuild the preimage: every scriptSig empty except this input's = scriptPubKey
    const ser: Uint8Array[] = [raw.subarray(0, 4), Uint8Array.of(tx.inputs.length)];
    tx.inputs.forEach((x, j) => {
      const sc = j === idx ? p2pkhScript(hash160(pub)) : new Uint8Array(0);
      ser.push(reversed(hexToBytes(x.prevTxid)), u32le(x.vout), Uint8Array.of(sc.length), sc, u32le(x.sequence));
    });
    // outputs + locktime + payload are the tail after the inputs, unchanged
    let off = 5;
    for (const x of tx.inputs) off += 36 + 1 + x.script.length + 4;
    ser.push(raw.subarray(off), u32le(1));
    const digest = sha256d(concatBytes(...ser));
    expect(secp256k1.verify(der, digest, pub, { prehash: false, format: 'der' })).toBe(true);
  });
}

describe('asset lock', () => {
  it('builds a signed type-8 tx crediting the key, burn = lock amount, fee = 1 duff/byte', () => {
    const b = buildAssetLock({ utxos: [utxo], fundingKey: key, creditPubKeyHash: h });
    const tx = parseTx(b.raw);
    expect(tx.version).toBe(3);
    expect(tx.type).toBe(8);
    expect(tx.txid).toBe(b.txid);
    expect(tx.outputs).toHaveLength(1);
    expect(bytesToHex(tx.outputs[0]!.script)).toBe(bytesToHex(BURN_SCRIPT));
    expect(tx.outputs[0]!.value).toBe(b.lockDuffs);
    expect(b.lockDuffs + b.feeDuffs).toBe(utxo.value);
    expect(b.feeDuffs).toBeGreaterThanOrEqual(BigInt(b.raw.length));
    expect(b.feeDuffs).toBeLessThan(BigInt(b.raw.length) + 5n);
    const p = parseAssetLockPayload(tx.extraPayload!);
    expect(p.version).toBe(1);
    expect(p.creditOutputs).toHaveLength(1);
    expect(p.creditOutputs[0]!.value).toBe(b.lockDuffs);
    expect(bytesToHex(p.creditOutputs[0]!.script)).toBe(bytesToHex(p2pkhScript(h)));
    checkSignatures(b.raw, publicKeyOf(key));
  });

  it('puts the burn after a change output when asked, and the credit index stays 0', () => {
    const change = { script: p2pkhScript(hash160(publicKeyOf(other))), duffs: 300_000n };
    const b = buildAssetLock({ utxos: [utxo, { ...utxo, vout: 2, value: 50_000n }], fundingKey: key, creditPubKeyHash: hash160(publicKeyOf(other)), lockDuffs: 400_000n, change });
    const tx = parseTx(b.raw);
    expect(b.burnVout).toBe(1);
    expect(b.creditIndex).toBe(0);
    expect(tx.outputs[1]!.value).toBe(400_000n);
    expect(tx.outputs[0]!.value).toBe(1_050_000n - 400_000n - b.feeDuffs);
    checkSignatures(b.raw, publicKeyOf(key));
    expect(locateCredit(tx, hash160(publicKeyOf(other)))).toEqual({ creditIndex: 0, burnVout: 1, creditDuffs: 400_000n });
    expect(() => locateCredit(tx, h)).toThrow(AssetLockError);
  });

  it('refuses dust and remainders without change', () => {
    expect(() => buildAssetLock({ utxos: [{ ...utxo, value: 100n }], fundingKey: key, creditPubKeyHash: h })).toThrow(/not enough/);
    expect(() => buildAssetLock({ utxos: [utxo], fundingKey: key, creditPubKeyHash: h, lockDuffs: 10_000n })).toThrow(/remainder/);
    expect(() => locateCredit(parseTx(buildPayment({ utxos: [utxo], key, to: [{ pubKeyHash: h, duffs: 1000n }] }).raw), h)).toThrow(/not an asset-lock/);
  });
});

describe('identity id from the outpoint', () => {
  it("equals evo-sdk's AssetLockProof.createIdentityId for credit index 0 and 1", () => {
    const b = buildAssetLock({ utxos: [utxo], fundingKey: key, creditPubKeyHash: h });
    for (const i of [0, 1]) {
      const proof = evo.AssetLockProof.createChainAssetLockProof(1000, new evo.OutPoint(b.txid, i));
      expect(identityIdFromOutpoint(b.txid, i)).toBe(proof.createIdentityId().toString());
    }
  });

  it("equals dash-faucet-cf's prospectiveIdentityId(txid, 0)", () => {
    const txid = '68136ac0b157d33bc5c53a7eec6bd1b688b86f2555fb890d5cc113b582e03a07';
    const faucet = toBase58(sha256d(concatBytes(reversed(hexToBytes(txid)), u32le(0))));
    expect(identityIdFromOutpoint(txid, 0)).toBe(faucet);
  });
});

describe('payment (test tooling)', () => {
  it('pays and returns change to the sender, signatures valid', () => {
    const p = buildPayment({ utxos: [utxo], key, to: [{ pubKeyHash: hash160(publicKeyOf(other)), duffs: 250_000n }] });
    const tx = parseTx(p.raw);
    expect(tx.type).toBe(0);
    expect(tx.outputs[0]!.value).toBe(250_000n);
    expect(p.changeVout).toBe(1);
    checkSignatures(p.raw, publicKeyOf(key));
  });
});

describe('sweep (Recover tool)', () => {
  it('spends every payment of the key into one output, fee = 1 duff/byte, signatures valid', () => {
    const utxos = [utxo, { txid: 'cd'.repeat(32), vout: 0, value: 25_000n }];
    const to = hash160(publicKeyOf(other));
    const b = buildSweep({ utxos, key, to: { type: 'p2pkh', hash160: to } });
    const tx = parseTx(b.raw);
    expect(tx.txid).toBe(b.txid);
    expect(tx.type).toBe(0);
    expect(tx.inputs.map((i) => `${i.prevTxid}:${i.vout}`)).toEqual(utxos.map((u) => `${u.txid}:${u.vout}`));
    expect(tx.outputs).toEqual([{ value: b.sentDuffs, script: p2pkhScript(to) }]);
    expect(b.sentDuffs + b.feeDuffs).toBe(1_025_000n);
    expect(b.feeDuffs).toBe(estimateSweepFee(2));
    expect(b.feeDuffs).toBeGreaterThanOrEqual(BigInt(b.raw.length));
    expect(b.feeDuffs).toBeLessThan(BigInt(b.raw.length) + 5n);
    checkSignatures(b.raw, publicKeyOf(key));
  });

  it('pays a P2SH address with its own script, and refuses to leave dust', () => {
    const b = buildSweep({ utxos: [utxo], key, to: { type: 'p2sh', hash160: h } });
    expect(parseTx(b.raw).outputs[0]!.script).toEqual(p2shScript(h));
    expect(b.feeDuffs).toBe(estimateSweepFee(1, true));
    const fee = estimateSweepFee(1);
    expect(() => buildSweep({ utxos: [{ ...utxo, value: fee + DUST_DUFFS - 1n }], key, to: { type: 'p2pkh', hash160: h } })).toThrow(/dust/);
    expect(buildSweep({ utxos: [{ ...utxo, value: fee + DUST_DUFFS }], key, to: { type: 'p2pkh', hash160: h } }).sentDuffs).toBe(DUST_DUFFS);
    expect(() => buildSweep({ utxos: [], key, to: { type: 'p2pkh', hash160: h } })).toThrow(/nothing/);
  });
});
