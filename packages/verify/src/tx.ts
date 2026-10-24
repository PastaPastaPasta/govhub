// Dash transaction (de)serialization. Source: src/primitives/transaction.h (CMutableTransaction::SERIALIZE_METHODS L355-365,
// COutPoint L70, CTxIn L161; txid rules primitives/transaction.cpp:76-94, transaction.h:383-395). There is no segwit marker in Dash.
import { Reader, sha256d, uint256ToDisplay } from './bytes.ts';

export const SPECIAL_TX_VERSION = 3;
export const TRANSACTION_NORMAL = 0;

export interface TxIn {
  /** Previous txid in internal (raw) byte order. */
  prevTxidRaw: Uint8Array;
  prevTxid: string;
  prevIndex: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface TxOut {
  /** duffs (int64). */
  value: bigint;
  script: Uint8Array;
}

export interface DashTx {
  /** int16 `nVersion` (low 16 bits of the first int32). */
  version: number;
  /** uint16 `nType` (high 16 bits of the first int32); only meaningful when version >= 3. */
  type: number;
  vin: TxIn[];
  vout: TxOut[];
  lockTime: number;
  /** Present only for special transactions (version >= 3 and type != 0). */
  extraPayload: Uint8Array | null;
  /** The txid Core uses (CTransaction::GetHash), internal byte order. SHA256d of the full serialization, except for
   *  asset-unlock payload v2+, where the trailing quorum signing info is zeroed first (primitives/transaction.cpp:76-94). */
  txidRaw: Uint8Array;
  /** Display hex txid. */
  txid: string;
  /** SHA256d of the full serialization (Core's GetInstanceHash); equals `txidRaw` except for stable-txid asset unlocks. */
  instanceHashRaw: Uint8Array;
}

/** primitives/transaction.h:47-51: requestedHeight (4) + quorumHash (32) + quorumSig (96); payload = version 1 + index 8 + fee 4 + info. */
export const ASSET_UNLOCK_QUORUM_INFO_SIZE = 4 + 32 + 96;
export const ASSET_UNLOCK_PAYLOAD_SIZE = 1 + 8 + 4 + ASSET_UNLOCK_QUORUM_INFO_SIZE;
export const ASSET_UNLOCK_STABLE_TXID_VERSION = 2;
export const TRANSACTION_ASSET_UNLOCK = 9;

/**
 * Parses a complete serialized transaction. Throws on truncation, non-canonical CompactSize, or trailing bytes.
 * txid = SHA256d(all bytes) - for special transactions that includes the extra payload.
 */
export function parseTransaction(raw: Uint8Array): DashTx {
  const r = new Reader(raw);
  const n32 = r.i32();
  const version = (n32 << 16) >> 16; // int16
  const type = (n32 >>> 16) & 0xffff; // uint16
  const nIn = r.compactSize();
  if (nIn > r.remaining) throw new Error('vin count exceeds data');
  const vin: TxIn[] = [];
  for (let i = 0; i < nIn; i++) {
    const prevTxidRaw = r.bytes(32).slice();
    const prevIndex = r.u32();
    const scriptSig = r.bytes(r.compactSize()).slice();
    const sequence = r.u32();
    vin.push({ prevTxidRaw, prevTxid: uint256ToDisplay(prevTxidRaw), prevIndex, scriptSig, sequence });
  }
  const nOut = r.compactSize();
  if (nOut > r.remaining) throw new Error('vout count exceeds data');
  const vout: TxOut[] = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.i64();
    const script = r.bytes(r.compactSize()).slice();
    vout.push({ value, script });
  }
  const lockTime = r.u32();
  let extraPayload: Uint8Array | null = null;
  if (version >= SPECIAL_TX_VERSION && type !== TRANSACTION_NORMAL) extraPayload = r.bytes(r.compactSize()).slice();
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after transaction`);
  const instanceHashRaw = sha256d(raw);
  let txidRaw = instanceHashRaw;
  if (version >= SPECIAL_TX_VERSION && type === TRANSACTION_ASSET_UNLOCK && extraPayload?.length === ASSET_UNLOCK_PAYLOAD_SIZE && extraPayload[0]! >= ASSET_UNLOCK_STABLE_TXID_VERSION) {
    // IsAssetUnlockWithStableTxid: the payload is the last serialized field, so the signing info is the stream's tail.
    const stable = raw.slice();
    stable.fill(0, stable.length - ASSET_UNLOCK_QUORUM_INFO_SIZE);
    txidRaw = sha256d(stable);
  }
  return { version, type, vin, vout, lockTime, extraPayload, txidRaw, txid: uint256ToDisplay(txidRaw), instanceHashRaw };
}
