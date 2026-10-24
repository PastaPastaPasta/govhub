// Recorded mainnet and testnet snapshots for the anchoring tests (scripts/record-anchor-fixtures.mjs): a header run, the full SML at a
// block inside it, the newest ChainLock, and the newest superblock.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hashHex, unhex } from '../src/bytes.ts';
import { decodeCbor } from '../src/cbor.ts';
import { parseChainLock, parseHeader } from '../src/dash.ts';
import type { Checkpoint, HeaderRun } from '../src/headerchain.ts';
import { x11Many } from '../src/x11.ts';

export interface AnchorFixture {
  network: 'mainnet' | 'testnet';
  now: number;
  from: number;
  headers: Uint8Array;
  hashes: Uint8Array;
  count: number;
  top: number;
  smlBytes: Uint8Array;
  sml: { [k: string]: unknown };
  chainLockBytes: Uint8Array;
  chainLock: ReturnType<typeof parseChainLock>;
  superblock: { height: number; block: Uint8Array };
  /** A checkpoint inside the run with DGW_WINDOW headers below it (the test pin). */
  checkpoint: Checkpoint;
  header(h: number): Uint8Array;
  hashAt(h: number): string;
  /** A checkpoint pinned at height h (hash, bits and time of that header). */
  cpAt(h: number): Checkpoint;
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export function loadAnchorFixture(network: 'mainnet' | 'testnet'): AnchorFixture {
  const j = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/anchor-${network}.json.gz`, import.meta.url))).toString('utf8'));
  const headers = b64(j.headersB64), hashes = x11Many(headers), count = headers.length / 80, from = j.from as number;
  const smlBytes = b64(j.smlB64);
  const header = (h: number) => headers.subarray((h - from) * 80, (h - from + 1) * 80);
  const hashAt = (h: number) => hashHex(hashes.subarray((h - from) * 32, (h - from + 1) * 32));
  const cpAt = (h: number): Checkpoint => { const p = parseHeader(header(h)); return { height: h, hash: hashAt(h), bits: p.bits, time: p.time }; };
  return {
    network, now: j.now, from, headers, hashes, count, top: from + count - 1, smlBytes, sml: decodeCbor(smlBytes) as AnchorFixture['sml'],
    chainLockBytes: unhex(j.chainLockHex), chainLock: parseChainLock(unhex(j.chainLockHex)),
    superblock: { height: j.superblock.height, block: b64(j.superblock.blockB64) },
    checkpoint: cpAt(from + 24), header, hashAt, cpAt,
  };
}

/** The headers of heights a..b (inclusive) as a HeaderRun. */
export function runOf(f: AnchorFixture, a: number, b: number): HeaderRun {
  return { from: a, headers: f.headers.slice((a - f.from) * 80, (b - f.from + 1) * 80), hashes: f.hashes.slice((a - f.from) * 32, (b - f.from + 1) * 32) };
}
