// Registration facts of masternodes, proven by the ProRegTx itself (loaded on first use).
//
// A masternode's type (regular / evonode) and collateral outpoint are set by its ProRegTx and never change: a service update with
// another type is invalid (evo/specialtxman.cpp:483-485, bad-protx-type-mismatch) and spending the collateral removes the
// masternode. The SML proves proRegTxHash, and a transaction's bytes are proven by hashing to its txid, so fetching the ProRegTx
// by that hash from any node proves both facts. This matters because the SML hash does not cover the type of version-1 entries
// (evo/simplifiedmns.h:89-99 serializes nType only from version 2) and never covers the collateral.
import { Reader } from './bytes.ts';
import type { Dapi } from './client.ts';
import { parseTx } from './dash.ts';
import { VerificationError } from './errors.ts';
import type { CallOptions } from './types.ts';

export interface ProRegInfo {
  /** MnType: 0 regular, 1 evonode (evo/dmn_types.h). */
  type: number;
  /** Collateral outpoint, display-order txid. A null outpoint in the payload means output `index` of the ProRegTx itself. */
  collateral: { txid: string; index: number };
}

/** Persistent cache: registration facts never change, so entries never expire. */
export interface ProRegCache {
  load(hashes: readonly string[]): Promise<Map<string, ProRegInfo>>;
  save(entries: ReadonlyMap<string, ProRegInfo>): Promise<void>;
}

const TRANSACTION_PROVIDER_REGISTER = 1; // primitives/transaction.h:30

/** CProRegTx payload start (evo/providertx.h:162-180): nVersion u16 | nType u16 | nMode u16 | collateralOutpoint (32 + u32) | ... */
export function parseProRegTx(raw: Uint8Array, proTxHash: string): ProRegInfo {
  const tx = parseTx(raw);
  if (tx.txid !== proTxHash) throw new VerificationError('protx', 'transaction does not hash to the proTxHash');
  if (tx.type !== TRANSACTION_PROVIDER_REGISTER || !tx.extraPayload) throw new VerificationError('protx', 'not a ProRegTx');
  const r = new Reader(tx.extraPayload);
  const version = r.u16();
  if (version < 1 || version > 3) throw new VerificationError('protx', `unknown ProRegTx version ${version}`);
  const type = r.u16();
  r.u16(); // nMode
  const hash = r.bytes(32), index = r.u32();
  const isNull = hash.every((b) => b === 0);
  const txid = isNull ? proTxHash : Array.from(hash).reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
  return { type, collateral: { txid, index } };
}

/**
 * ProRegTx facts for `hashes` (display order), from the cache first, the rest from DAPI (`parallel` at a time, each answer checked
 * by its hash; a wrong answer moves to another node). Throws if any cannot be proven.
 */
export async function getProRegInfo(
  d: Dapi, hashes: readonly string[], o: CallOptions & { cache?: ProRegCache; parallel?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, ProRegInfo>> {
  const want = [...new Set(hashes.map((h) => h.toLowerCase()))];
  const out = new Map<string, ProRegInfo>();
  const cached = await o.cache?.load(want).catch(() => new Map<string, ProRegInfo>());
  for (const [k, v] of cached ?? []) out.set(k, v);
  const missing = want.filter((h) => !out.has(h));
  const fresh = new Map<string, ProRegInfo>();
  let next = 0, done = 0;
  const work = async () => {
    while (next < missing.length) {
      const h = missing[next++]!;
      const { value } = await d.call(async (core, signal) => parseProRegTx((await core.getTransaction(h, { signal })).raw, h), o);
      fresh.set(h, value);
      out.set(h, value);
      o.onProgress?.(++done, missing.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(o.parallel ?? 24, missing.length) }, work));
  } finally {
    if (fresh.size) await o.cache?.save(fresh).catch(() => {});
  }
  return out;
}
