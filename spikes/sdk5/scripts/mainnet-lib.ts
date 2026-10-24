// Mainnet helpers for the PV13 write check: key derivation from the BIP39 mnemonic (outside the repo),
// Insight REST (mainnet), asset-lock builder (with change), IS-lock watcher over DAPI, state storage.
// Key material is derived on demand and NEVER printed or stored in the repo. State (txids, ids, spend
// ledger; no keys) lives in ~/.local/share/govhub-phase0/mainnet/state.json (0700 dir, 0600 file).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import dashcore from '@dashevo/dashcore-lib';
import { sleep } from './lib.ts';
// DAPI Core client from the dapi-browser spike (plain ESM, only dependency @noble/hashes)
// @ts-ignore no types for the JS spike
import { DapiCore } from '../../dapi-browser/src/core.js';
// @ts-ignore
import { fetchNodes, sample } from '../../dapi-browser/src/nodes.js';
// @ts-ignore
import { BloomFilter, matchAllFilter } from '../../dapi-browser/src/bloom.js';
// @ts-ignore
import { mergeStreams } from '../../dapi-browser/src/race.js';
// @ts-ignore
import { parseInstantLock, hex as toHex } from '../../dapi-browser/src/dash.js';

const { PrivateKey, Transaction, Script, Opcode, HDPrivateKey, crypto: dcrypto } = dashcore as any;

export const NET = 'livenet';
export const BASE = join(homedir(), '.local/share/govhub-phase0');
export const STATE_DIR = join(BASE, 'mainnet');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const INSIGHT = 'https://insight.dash.org/insight-api';
export const FUNDING_ADDRESS = 'XrrdbDqut3RJYGzBC1pbEJcff1DULADXsd';

export function readState<T = any>(fallback: T): T {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : fallback;
}
export function writeState(data: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n', { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

// ---- keys ----
let root: any;
function hdRoot(): any {
  if (root) return root;
  const mnemonic = readFileSync(join(BASE, 'mainnet-mnemonic.txt'), 'utf8').trim().split(/\s+/).join(' ').normalize('NFKD');
  const seed = pbkdf2Sync(Buffer.from(mnemonic, 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
  root = HDPrivateKey.fromSeed(seed, NET);
  return root;
}
/** Private key (hex) at an HD path; never print. */
export const keyHexAt = (path: string): string => hdRoot().deriveChild(path).privateKey.toString();
export const addressOf = (hex: string): string => new PrivateKey(hex, NET).toAddress(NET).toString();
export const wifOf = (hex: string): string => new PrivateKey(hex, NET).toWIF();
export const pubKeyOf = (hex: string): Uint8Array => Uint8Array.from(new PrivateKey(hex, NET).toPublicKey().toBuffer());

export const FUNDING_PATH = (i: number) => `m/9'/5'/5'/1'/${i}'`;
export const IDENTITY_KEY_PATH = (identityIndex: number, keyIndex: number) => `m/9'/5'/5'/0'/0'/${identityIndex}'/${keyIndex}'`;
export const IDENTITY_KEYS = [
  { keyId: 0, purpose: 'authentication', securityLevel: 'master' },
  { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
];

// ---- Insight (mainnet) ----
// insight.dash.org answers 403 to Node's default fetch user-agent; send a curl-like one.
const IH = { 'user-agent': 'curl/8.7.1', accept: 'application/json' };
export async function fetchUtxos(address: string): Promise<any[]> {
  const r = await fetch(`${INSIGHT}/addr/${address}/utxo`, { headers: IH, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`utxo lookup ${r.status}`);
  return r.json();
}
export async function fetchTx(txid: string): Promise<any | null> {
  const r = await fetch(`${INSIGHT}/tx/${txid}`, { headers: IH, signal: AbortSignal.timeout(30000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`tx lookup ${r.status}`);
  return r.json();
}
export async function broadcastTx(rawtx: string): Promise<string> {
  const r = await fetch(`${INSIGHT}/tx/send`, { method: 'POST', headers: { ...IH, 'content-type': 'application/json' }, body: JSON.stringify({ rawtx }), signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast ${r.status}: ${body.slice(0, 300)}`);
  return body;
}
export async function waitMined(txid: string, label: string, tries = 360): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const tx = await fetchTx(txid).catch(() => null);
    if (tx?.blockheight > 0) return tx.blockheight;
    if (i % 6 === 0) console.log(`  ... waiting for ${label} ${txid.slice(0, 12)} to be mined (${i * 5}s)`);
    await sleep(5000);
  }
  throw new Error(`${txid} not mined`);
}

// ---- transactions ----
const utxoIn = (u: any, address: string) => ({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: u.satoshis, address });

/**
 * Asset lock (type 8): one OP_RETURN burn output worth `lockDuffs` plus an optional change output back to
 * `changeAddress`. The credit output (payload) pays `creditKeyHex`'s address. The burn output index is
 * discovered from the built transaction (it is NOT assumed to be 0).
 */
export function buildAssetLockTx(inputKeyHex: string, utxo: any, creditKeyHex: string, lockDuffs: number, feeDuffs: number, changeAddress?: string) {
  const inKey = new PrivateKey(inputKeyHex, NET);
  const creditAddress = new PrivateKey(creditKeyHex, NET).toAddress(NET);
  const payload = Transaction.Payload.AssetLockPayload.fromJSON({
    version: 1,
    creditOutputs: [{ satoshis: lockDuffs, script: Script.buildPublicKeyHashOut(creditAddress).toString() }],
  });
  const tx = new Transaction()
    .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
    .from([utxoIn(utxo, inKey.toAddress(NET).toString())])
    .addOutput(new Transaction.Output({ satoshis: lockDuffs, script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)) }));
  const changeDuffs = utxo.satoshis - lockDuffs - feeDuffs;
  if (changeDuffs < 0) throw new Error('utxo too small');
  if (changeDuffs > 0) {
    if (!changeAddress) throw new Error('change address required');
    tx.to(changeAddress, changeDuffs);
  }
  tx.setExtraPayload(payload).sign(inKey);
  // find the burn output (OP_RETURN) and the change output by script, do not assume positions
  const outs: any[] = tx.outputs;
  const burnIndex = outs.findIndex((o) => o.script.isDataOut());
  const changeIndex = outs.findIndex((o, i) => i !== burnIndex);
  if (burnIndex < 0 || outs[burnIndex].satoshis !== lockDuffs) throw new Error('burn output not found / wrong amount');
  const rawtx = tx.uncheckedSerialize() as string;
  // sanity: sum(in) - sum(out) == fee
  const sumOut = outs.reduce((a, o) => a + o.satoshis, 0);
  if (utxo.satoshis - sumOut !== feeDuffs) throw new Error('fee mismatch');
  return {
    txid: tx.id as string, rawtx, burnIndex: burnIndex as number, lockDuffs,
    change: changeDuffs > 0 ? { index: changeIndex as number, duffs: changeDuffs as number, scriptPubKey: outs[changeIndex].script.toHex() as string, address: changeAddress as string } : undefined,
    sizeBytes: rawtx.length / 2,
  };
}

// ---- IS-lock watcher (DAPI grpc-web streams over several evonodes; IS-locks are never replayed) ----
export type IsLockWatcher = { wait(txid: string, timeoutMs: number): Promise<Uint8Array | null>; got: Map<string, Uint8Array>; stop(): void; stats(): any };
export async function startIsLockWatcher(bloomElements: Uint8Array[], nodesWanted = 3): Promise<IsLockWatcher> {
  const nodes = sample(await fetchNodes(), 24) as string[];
  const probe = new DapiCore(nodes[0]);
  const height: number = await probe.getBestBlockHeight();
  const got = new Map<string, Uint8Array>();
  const waiters: Array<{ txid: string; resolve: (v: Uint8Array) => void }> = [];
  let k = 0;
  const handle = mergeStreams(
    nodes,
    (node: string, emit: (key: string, item: any) => void, signal: AbortSignal) => {
      const useAll = k++ === 0; // one match-all stream as belt-and-braces, the rest use a bloom filter
      let filter: any;
      if (useAll) filter = matchAllFilter();
      else {
        const bf = new BloomFilter(Math.max(bloomElements.length, 4), 0.0001);
        for (const e of bloomElements) bf.insert(e);
        filter = bf.toJSON();
      }
      return new DapiCore(node).subscribeToTransactionsWithProofs(filter, { fromHeight: height, count: 0 }, (ev: any) => {
        if (ev.type !== 'islocks') return;
        for (const m of ev.messages as Uint8Array[]) {
          let p: any;
          try { p = parseInstantLock(m); } catch { continue; }
          emit(p.txid, { txid: p.txid, bytes: m });
        }
      }, { signal });
    },
    (item: { txid: string; bytes: Uint8Array }) => {
      got.set(item.txid, item.bytes);
      for (const w of waiters.filter((x) => x.txid === item.txid)) w.resolve(item.bytes);
    },
    { n: nodesWanted, maxReplacements: 12 },
  );
  return {
    got,
    stop: () => handle.cancel(),
    stats: () => handle.stats(),
    async wait(txid: string, timeoutMs: number) {
      if (got.has(txid)) return got.get(txid)!;
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({ txid, resolve: (v) => { clearTimeout(t); resolve(v); } });
      });
    },
  };
}

/** hash160 / pubkey / outpoint elements for the bloom filter */
export function bloomElementsFor(keyHex: string, outpoints: { txid: string; vout: number }[]): Uint8Array[] {
  const pk = new PrivateKey(keyHex, NET).toPublicKey().toBuffer() as Buffer;
  const h160 = dcrypto.Hash.sha256ripemd160(pk) as Buffer;
  const els: Uint8Array[] = [Uint8Array.from(pk), Uint8Array.from(h160)];
  for (const o of outpoints) {
    const b = Buffer.alloc(36);
    Buffer.from(o.txid, 'hex').reverse().copy(b, 0);
    b.writeUInt32LE(o.vout, 32);
    els.push(Uint8Array.from(b));
  }
  return els;
}

export { DapiCore, fetchNodes, sample, toHex };
export const redact = (s: unknown): string => String((s as any)?.message ?? s).replace(/\b[0-9a-fA-F]{64}\b/g, '[HEX]').replace(/\b[XYK7][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[WIF]');
