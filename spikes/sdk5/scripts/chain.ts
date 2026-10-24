// Testnet Core-chain helpers (Insight REST + dashcore-lib) and local key-state storage.
// Adapted from the EvoVote v2 QA harness (qa-lib.mjs). Key material lives ONLY in
// ~/.local/share/govhub-phase0/testnet/ (0700 dir, 0600 files), never in the repo.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import dashcore from '@dashevo/dashcore-lib';
import { sleep } from './lib.ts';

const { PrivateKey, Transaction, Script, Opcode } = dashcore as any;

export const STATE_DIR = join(homedir(), '.local/share/govhub-phase0/testnet');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const INSIGHT = 'https://insight.testnet.networks.dash.org/insight-api';
export const FAUCET = 'https://faucet.thepasta.org';

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

export function freshKeyHex(): string {
  for (;;) {
    const hex = randomBytes(32).toString('hex');
    try { new PrivateKey(hex, 'testnet'); return hex; } catch { /* out of range, retry */ }
  }
}
export const addressOf = (hex: string): string => new PrivateKey(hex, 'testnet').toAddress('testnet').toString();
export const wifOf = (hex: string): string => new PrivateKey(hex, 'testnet').toWIF();
export const pubKeyOf = (hex: string): Uint8Array => Uint8Array.from(new PrivateKey(hex, 'testnet').toPublicKey().toBuffer());

export async function fetchUtxos(address: string): Promise<any[]> {
  const r = await fetch(`${INSIGHT}/addr/${address}/utxo`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`utxo lookup ${r.status}`);
  return r.json();
}
async function fetchTx(txid: string): Promise<any | null> {
  const r = await fetch(`${INSIGHT}/tx/${txid}`, { signal: AbortSignal.timeout(30000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`tx lookup ${r.status}`);
  return r.json();
}
export async function broadcastTx(rawtx: string): Promise<string> {
  const r = await fetch(`${INSIGHT}/tx/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawtx }), signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast ${r.status}: ${body.slice(0, 300)}`);
  return body;
}
export async function waitMined(txid: string, label: string, tries = 240): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const tx = await fetchTx(txid).catch(() => null);
    if (tx?.blockheight > 0) return tx.blockheight;
    if (i % 6 === 0) console.log(`  … waiting for ${label} ${txid.slice(0, 12)} to be mined (${i * 5}s)`);
    await sleep(5000);
  }
  throw new Error(`${txid} not mined`);
}
export async function waitUtxos(address: string, minSats: number, label: string, tries = 120): Promise<any[]> {
  for (let i = 0; i < tries; i++) {
    const u = await fetchUtxos(address).catch(() => []);
    const total = u.reduce((a: number, x: any) => a + x.satoshis, 0);
    if (total >= minSats) return u;
    if (i % 6 === 0) console.log(`  … waiting for ${label}: ${total}/${minSats} sats at ${address.slice(0, 8)}… (${i * 5}s)`);
    await sleep(5000);
  }
  throw new Error(`funds for ${label} never arrived`);
}

const utxoIn = (u: any, address: string) => ({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: u.satoshis, address });

/** One P2PKH output per recipient, change back to the wallet. */
export function buildSplitTx(walletHex: string, utxos: any[], recipients: { address: string; duffs: number }[]) {
  const key = new PrivateKey(walletHex, 'testnet');
  const address = key.toAddress('testnet').toString();
  const tx = new Transaction().from(utxos.map((u) => utxoIn(u, address)));
  for (const r of recipients) tx.to(r.address, r.duffs);
  tx.change(address).feePerKb(1000).sign(key);
  return { txid: tx.id as string, rawtx: tx.serialize() as string };
}

/** Asset lock (type 8): one OP_RETURN burn output; the credit output pays the one-shot key. */
export function buildAssetLockTx(lockHex: string, utxo: any) {
  const key = new PrivateKey(lockHex, 'testnet');
  const address = key.toAddress('testnet');
  const creditDuffs = utxo.satoshis - 500;
  const payload = Transaction.Payload.AssetLockPayload.fromJSON({
    version: 1,
    creditOutputs: [{ satoshis: creditDuffs, script: Script.buildPublicKeyHashOut(address).toString() }],
  });
  const tx = new Transaction()
    .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
    .from([utxoIn(utxo, address.toString())])
    .addOutput(new Transaction.Output({ satoshis: creditDuffs, script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)) }))
    .setExtraPayload(payload)
    .sign(key);
  return { txid: tx.id as string, rawtx: tx.uncheckedSerialize() as string, creditDuffs: creditDuffs as number };
}

// ---- faucet CAP proof-of-work (cap.js wire protocol; same solver as mainnet-bridge/scripts/qa-create-testnet-identity.ts) ----
function prng(seed: string, length: number): string {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { state = (state ^ seed.charCodeAt(i)) >>> 0; state = Math.imul(state, 0x01000193) >>> 0; }
  let out = '';
  while (out.length < length) {
    state = (state ^ (state << 13)) >>> 0; state = (state ^ (state >>> 17)) >>> 0; state = (state ^ (state << 5)) >>> 0;
    out += state.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}
const enc = new TextEncoder();
const hasPrefix = (digest: Uint8Array, target: string): boolean => {
  const bytes = (target.length + 1) >> 1;
  let hex = '';
  for (let i = 0; i < bytes; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex.startsWith(target);
};
export async function solveCap(): Promise<string> {
  const ch: any = await (await fetch(`${FAUCET}/cap/v1/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const { c, s, d } = ch.challenge as { c: number; s: number; d: number };
  const token = ch.token as string;
  const solutions: number[] = [];
  const t0 = Date.now();
  for (let i = 1; i <= c; i++) {
    const salt = prng(`${token}${i}`, s);
    const target = prng(`${token}${i}d`, d);
    let nonce = 0;
    while (!hasPrefix(sha256(enc.encode(salt + String(nonce))), target)) nonce++;
    solutions.push(nonce);
  }
  console.log(`  CAP solved: ${c} sub-challenges in ${Date.now() - t0} ms`);
  const r = await fetch(`${FAUCET}/cap/v1/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, solutions }) });
  const body: any = await r.json();
  if (!r.ok || !body.success) throw new Error(`CAP redeem failed: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.token as string;
}

export async function requestFaucet(address: string): Promise<{ txid: string; amount: number }> {
  const capToken = await solveCap();
  const r = await fetch(`${FAUCET}/api/core-faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, capToken }) });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`faucet ${r.status}: ${JSON.stringify({ ...body, capToken: undefined }).slice(0, 300)}`);
  return { txid: body.txid, amount: body.amount };
}

export const redact = (s: unknown): string => String((s as any)?.message ?? s).replace(/\b[0-9a-fA-F]{64}\b/g, '[HEX]').replace(/\bc[1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[WIF]');
