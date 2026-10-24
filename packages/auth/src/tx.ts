// Core transactions the browser builds: the type-8 asset lock (identity create / top-up) and, for tooling, a plain P2PKH payment.
// Legacy sighash (Dash has no segwit): sha256d(tx with every scriptSig empty except the signed input's = its scriptPubKey || u32le(1)).
// Format references: Dash Core src/primitives/transaction.h (CTransaction serialization, nVersion | nType << 16, vExtraPayload),
// src/evo/assetlocktx.h (CAssetLockPayload: u8 version, vector<CTxOut> creditOutputs), src/evo/assetlocktx.cpp CheckAssetLockTx.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { parseTx, type Tx } from '@govhub/dapi';
import { compactSize, i64le } from '@govhub/verify';
import { bytesEqual, concatBytes, hash160, hexToBytes, reversed, sha256d, toBase58, u32le } from './bytes.ts';
import { publicKeyOf } from './keys.ts';

export interface Utxo {
  /** Display-order txid. */
  txid: string;
  vout: number;
  /** Duffs. */
  value: bigint;
}

export interface TxOutput {
  value: bigint;
  script: Uint8Array;
}

export const p2pkhScript = (h160: Uint8Array): Uint8Array => {
  if (h160.length !== 20) throw new Error('hash160 must be 20 bytes');
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));
};
/** The asset lock's burn output script: OP_RETURN with one empty push (what Core and Dash Bridge use). */
export const BURN_SCRIPT = Uint8Array.of(0x6a, 0x00);

const TX_VERSION_SPECIAL = 3;
const TX_TYPE_ASSET_LOCK = 8;
const SIGHASH_ALL = 1;

interface UnsignedTx {
  version: number;
  type: number;
  inputs: Array<{ txid: string; vout: number; scriptSig: Uint8Array; sequence: number }>;
  outputs: TxOutput[];
  lockTime: number;
  extraPayload: Uint8Array | null;
}

function serialize(tx: UnsignedTx): Uint8Array {
  const parts: Uint8Array[] = [u32le(((tx.type << 16) | tx.version) >>> 0), compactSize(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(reversed(hexToBytes(i.txid)), u32le(i.vout), compactSize(i.scriptSig.length), i.scriptSig, u32le(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(i64le(o.value), compactSize(o.script.length), o.script);
  parts.push(u32le(tx.lockTime));
  if (tx.extraPayload) parts.push(compactSize(tx.extraPayload.length), tx.extraPayload);
  return concatBytes(...parts);
}

const push = (data: Uint8Array): Uint8Array => {
  if (data.length > 75) throw new Error('push too long');
  return concatBytes(Uint8Array.of(data.length), data);
};

/** Signs every input, all of which spend P2PKH outputs of `privateKey`. */
function signAll(tx: UnsignedTx, privateKey: Uint8Array): Uint8Array {
  const pub = publicKeyOf(privateKey);
  const scriptCode = p2pkhScript(hash160(pub));
  const sigs = tx.inputs.map((_, idx) => {
    const copy: UnsignedTx = { ...tx, inputs: tx.inputs.map((x, j) => ({ ...x, scriptSig: j === idx ? scriptCode : new Uint8Array(0) })) };
    const digest = sha256d(concatBytes(serialize(copy), u32le(SIGHASH_ALL)));
    const der = secp256k1.sign(digest, privateKey, { prehash: false, format: 'der', lowS: true });
    return concatBytes(push(concatBytes(der, Uint8Array.of(SIGHASH_ALL))), push(pub));
  });
  return serialize({ ...tx, inputs: tx.inputs.map((x, j) => ({ ...x, scriptSig: sigs[j]! })) });
}

/** Asset-lock payload v1 with the given credit outputs. */
export function assetLockPayload(creditOutputs: readonly TxOutput[]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(1), compactSize(creditOutputs.length)];
  for (const o of creditOutputs) parts.push(i64le(o.value), compactSize(o.script.length), o.script);
  return concatBytes(...parts);
}

/** Parses a v1 asset-lock payload (u8 version, compact count, then CTxOut each). */
export function parseAssetLockPayload(payload: Uint8Array): { version: number; creditOutputs: TxOutput[] } {
  let i = 0;
  const need = (n: number) => {
    if (i + n > payload.length) throw new Error('asset lock payload truncated');
  };
  const varint = (): number => {
    need(1);
    const f = payload[i++]!;
    if (f < 253) return f;
    const w = f === 253 ? 2 : f === 254 ? 4 : 8;
    need(w);
    let v = 0;
    for (let k = w - 1; k >= 0; k--) v = v * 256 + payload[i + k]!;
    i += w;
    return v;
  };
  need(1);
  const version = payload[i++]!;
  const n = varint();
  const creditOutputs: TxOutput[] = [];
  for (let k = 0; k < n; k++) {
    need(8);
    const value = new DataView(payload.buffer, payload.byteOffset + i, 8).getBigInt64(0, true);
    i += 8;
    const len = varint();
    need(len);
    creditOutputs.push({ value, script: payload.slice(i, i + len) });
    i += len;
  }
  if (i !== payload.length) throw new Error('asset lock payload has trailing bytes');
  return { version, creditOutputs };
}

// Serialized size: version 4 + vin count 1 + per input (36 outpoint + 1 + 107 scriptSig (73 DER+hashtype, 33 pubkey, 2 pushes) + 4)
// + vout count 1 + per output (8 + 1 + script) + locktime 4 + payload (compact length + payload).
const INPUT_BYTES = 148;
const estimateSize = (inputs: number, outputScripts: readonly number[], payload: number): number =>
  10 + inputs * INPUT_BYTES + outputScripts.reduce((a, s) => a + 9 + s, 0) + (payload ? compactSize(payload).length + payload : 0);

/** PLAN risk list: DAPI has no fee estimate; Core's default minimum relay fee is 1000 duffs/kB, so 1 duff/byte. */
export const FEE_PER_BYTE = 1n;
/** Platform refuses asset locks with more inputs (rs-platform-version `max_asset_lock_transaction_inputs`, v3/v4). */
export const MAX_ASSET_LOCK_INPUTS = 100;

/** The Core fee of an asset lock spending `inputs` P2PKH outputs with no change (what buildAssetLock will charge). */
export function estimateAssetLockFee(inputs: number, feePerByte = FEE_PER_BYTE): bigint {
  const payloadLen = assetLockPayload([{ value: 0n, script: p2pkhScript(new Uint8Array(20)) }]).length;
  return BigInt(estimateSize(inputs, [BURN_SCRIPT.length], payloadLen)) * feePerByte;
}

export interface BuiltAssetLock {
  raw: Uint8Array;
  txid: string;
  /** Duffs credited to Platform. */
  lockDuffs: bigint;
  feeDuffs: bigint;
  /** Index of the burn output in the transaction's outputs (informational: Platform never uses it). */
  burnVout: number;
  /** Index of the credit output in the payload's creditOutputs: what the asset-lock proof and the identity id commit to. */
  creditIndex: number;
}

/**
 * Asset lock spending `utxos` (all P2PKH to `fundingKey`), burning everything but the fee and crediting it to `creditPubKeyHash`
 * (usually the funding key's own hash: one one-time key funds and signs the proof). `changeScript` + `changeDuffs` add an ordinary
 * output first, so the burn is NOT vout 0 (used by tests and the voucher minter to exercise that path).
 */
export function buildAssetLock(o: {
  utxos: readonly Utxo[];
  fundingKey: Uint8Array;
  creditPubKeyHash: Uint8Array;
  lockDuffs?: bigint;
  change?: { script: Uint8Array; duffs: bigint };
  feePerByte?: bigint;
  /** Platform's floor for the lock (MIN_CREATE_LOCK_DUFFS / MIN_TOPUP_LOCK_DUFFS): below it the burn would buy nothing. */
  minLockDuffs?: bigint;
}): BuiltAssetLock {
  if (!o.utxos.length) throw new Error('no funds to lock');
  if (o.utxos.length > MAX_ASSET_LOCK_INPUTS) throw new AssetLockError(`an asset lock may spend at most ${MAX_ASSET_LOCK_INPUTS} payments`);
  const total = o.utxos.reduce((a, u) => a + u.value, 0n);
  const credit = p2pkhScript(o.creditPubKeyHash);
  const outScripts = [BURN_SCRIPT.length, ...(o.change ? [o.change.script.length] : [])];
  const payloadLen = assetLockPayload([{ value: 0n, script: credit }]).length;
  const fee = BigInt(estimateSize(o.utxos.length, outScripts, payloadLen)) * (o.feePerByte ?? FEE_PER_BYTE);
  const changeDuffs = o.change?.duffs ?? 0n;
  const lockDuffs = o.lockDuffs ?? total - fee - changeDuffs;
  if (lockDuffs <= 0n || total - lockDuffs - changeDuffs < fee) throw new Error(`not enough funds: ${total} duffs cannot cover the lock and a ${fee} duff fee`);
  if (o.minLockDuffs !== undefined && lockDuffs < o.minLockDuffs) throw new AssetLockError(`the lock would be ${lockDuffs} duffs after fees; Platform needs at least ${o.minLockDuffs}`);
  const leftover = total - lockDuffs - changeDuffs - fee;
  if (leftover !== 0n && !o.change) throw new Error('lockDuffs leaves an unspent remainder and no change output');
  const outputs: TxOutput[] = [];
  if (o.change) outputs.push({ value: changeDuffs + leftover, script: o.change.script });
  outputs.push({ value: lockDuffs, script: BURN_SCRIPT });
  const raw = signAll(
    {
      version: TX_VERSION_SPECIAL,
      type: TX_TYPE_ASSET_LOCK,
      inputs: o.utxos.map((u) => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff })),
      outputs,
      lockTime: 0,
      extraPayload: assetLockPayload([{ value: lockDuffs, script: credit }]),
    },
    o.fundingKey,
  );
  const tx = parseTx(raw);
  const located = locateCredit(tx, o.creditPubKeyHash);
  return { raw, txid: tx.txid, lockDuffs, feeDuffs: total - lockDuffs - changeDuffs - leftover, burnVout: located.burnVout, creditIndex: located.creditIndex };
}

/** Plain P2PKH payment from `key`'s UTXOs to `to`, change back to `key` (test tooling: the e2e funder and the voucher minter). */
export function buildPayment(o: { utxos: readonly Utxo[]; key: Uint8Array; to: Array<{ pubKeyHash: Uint8Array; duffs: bigint }>; feePerByte?: bigint }): { raw: Uint8Array; txid: string; changeVout: number | null } {
  const total = o.utxos.reduce((a, u) => a + u.value, 0n);
  const own = p2pkhScript(hash160(publicKeyOf(o.key)));
  const outputs: TxOutput[] = o.to.map((t) => ({ value: t.duffs, script: p2pkhScript(t.pubKeyHash) }));
  const fee = BigInt(estimateSize(o.utxos.length, [...outputs.map((x) => x.script.length), own.length], 0)) * (o.feePerByte ?? FEE_PER_BYTE);
  const change = total - outputs.reduce((a, x) => a + x.value, 0n) - fee;
  if (change < 0n) throw new Error('insufficient funds');
  const changeVout = change >= 1000n ? outputs.push({ value: change, script: own }) - 1 : null;
  const raw = signAll(
    { version: 2, type: 0, inputs: o.utxos.map((u) => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff })), outputs, lockTime: 0, extraPayload: null },
    o.key,
  );
  return { raw, txid: parseTx(raw).txid, changeVout };
}

/**
 * A governance proposal collateral (PLAN 6.1): `OP_RETURN <32-byte gov hash, RAW byte order>` worth `burnDuffs` (Core: >= 1 DASH,
 * GOVERNANCE_PROPOSAL_FEE_TX) plus P2PKH change to `key`. Every output is P2PKH or unspendable, as IsCollateralValid requires.
 */
export function buildProposalCollateral(o: { utxos: readonly Utxo[]; key: Uint8Array; govHashRaw: Uint8Array; burnDuffs?: bigint; feePerByte?: bigint }): { raw: Uint8Array; txid: string; changeVout: number | null } {
  if (o.govHashRaw.length !== 32) throw new Error('the governance hash must be 32 bytes');
  const burn = o.burnDuffs ?? 100_000_000n;
  if (burn < 100_000_000n) throw new Error('Core requires at least 1 DASH of collateral');
  const total = o.utxos.reduce((a, u) => a + u.value, 0n);
  const own = p2pkhScript(hash160(publicKeyOf(o.key)));
  const outputs: TxOutput[] = [{ value: burn, script: concatBytes(Uint8Array.of(0x6a, 0x20), o.govHashRaw) }];
  const fee = BigInt(estimateSize(o.utxos.length, [34, own.length], 0)) * (o.feePerByte ?? FEE_PER_BYTE);
  const change = total - burn - fee;
  if (change < 0n) throw new Error('insufficient funds');
  const changeVout = change >= 1000n ? outputs.push({ value: change, script: own }) - 1 : null;
  const raw = signAll(
    { version: 2, type: 0, inputs: o.utxos.map((u) => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff })), outputs, lockTime: 0, extraPayload: null },
    o.key,
  );
  return { raw, txid: parseTx(raw).txid, changeVout };
}

export class AssetLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetLockError';
  }
}

/**
 * Where an asset lock credits `pubKeyHash`. `creditIndex` is the index into the payload's creditOutputs, which is what Platform
 * calls the outpoint's vout: rs-dpp `InstantAssetLockProof::output()` = `payload.credit_outputs.get(output_index)`, and the chain
 * proof's `out_point.vout` goes through the same `credit_outputs.get(...)` (validate_asset_lock_transaction_structure v0). The burn
 * output's position among the tx outputs is irrelevant to Platform; with one credit output the index is 0 wherever the burn sits.
 * Also checks Core's own rule (CheckAssetLockTx): the OP_RETURN outputs sum to the credit outputs.
 */
export function locateCredit(tx: Tx, pubKeyHash: Uint8Array): { creditIndex: number; burnVout: number; creditDuffs: bigint } {
  if (tx.type !== TX_TYPE_ASSET_LOCK || !tx.extraPayload) throw new AssetLockError('not an asset-lock transaction');
  const { version, creditOutputs } = parseAssetLockPayload(tx.extraPayload);
  if (version !== 1) throw new AssetLockError(`unknown asset-lock payload version ${version}`);
  const want = p2pkhScript(pubKeyHash);
  const creditIndex = creditOutputs.findIndex((c) => bytesEqual(c.script, want));
  if (creditIndex < 0) throw new AssetLockError('the asset lock does not credit this key');
  const burns = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.script[0] === 0x6a);
  const burnSum = burns.reduce((a, b) => a + b.o.value, 0n);
  const creditSum = creditOutputs.reduce((a, c) => a + c.value, 0n);
  if (!burns.length || burnSum !== creditSum) throw new AssetLockError('burn outputs do not match the credit outputs');
  return { creditIndex, burnVout: burns[0]!.i, creditDuffs: creditOutputs[creditIndex]!.value };
}

/** Identity id = sha256d(txid (internal order) || u32le(creditIndex)), base58 (rs-dpp `create_identifier`). */
export function identityIdFromOutpoint(txid: string, creditIndex: number): string {
  return toBase58(sha256d(concatBytes(reversed(hexToBytes(txid)), u32le(creditIndex))));
}
