import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesToHex, governanceObjectHash, hexToBytes, sha256d } from '@govhub/verify';
import { govObjectHash, parseHashBody, parseRawGovObject, parseRawVote, serializeGovObject, serializeVote, voteHash } from '../src/core/govparse.ts';
import { parseGovernanceDat } from '../src/core/govdat.ts';
import { FIXTURES, objectsFixture, votesFixture } from './helpers.ts';

describe('raw governance votes (ZMQ rawgovernancevote, recorded on mainnet)', () => {
  const f = votesFixture();
  const all = f.proposals.flatMap((p) => p.votes.map((v) => ({ ...v, parent: p.govHash })));

  it('parses every recorded vote; the computed vote hash equals the hash Core keys it by', () => {
    expect(all.length).toBeGreaterThan(500);
    for (const v of all) {
      const p = parseRawVote(hexToBytes(v.rawHex));
      expect(p.hash).toBe(v.hash);
      expect(p.parentHash).toBe(v.parent);
      expect(p.signal).toBe(1);
      expect([1, 2, 3]).toContain(p.outcome);
      expect(p.sig.length).toBe(65);
      expect(bytesToHex(serializeVote(p))).toBe(v.rawHex);
    }
  });

  it('parses an operator (BLS, 96-byte) vote', () => {
    expect(f.blsVote).not.toBeNull();
    const p = parseRawVote(hexToBytes(f.blsVote!.rawHex));
    expect(p.sig.length).toBe(96);
    expect(p.hash).toBe(f.blsVote!.hash);
  });

  it('rejects truncation, trailing bytes and signature sizes Core refuses on the network', () => {
    const raw = hexToBytes(all[0]!.rawHex);
    expect(() => parseRawVote(raw.subarray(0, raw.length - 1))).toThrow();
    expect(() => parseRawVote(Uint8Array.from([...raw, 0]))).toThrow(/trailing/);
    const p = parseRawVote(raw);
    expect(() => parseRawVote(serializeVote({ ...p, sig: new Uint8Array(64) }))).toThrow(/signature size/);
    expect(() => parseRawVote(serializeVote({ ...p, sig: new Uint8Array(97) }))).toThrow(/96/);
  });

  it('vote hash covers signal before outcome (vote.cpp UpdateHash) and not the signature', () => {
    const p = parseRawVote(hexToBytes(all[0]!.rawHex));
    expect(voteHash(p)).toBe(p.hash);
    expect(parseRawVote(serializeVote({ ...p, sig: new Uint8Array(65).fill(7) })).hash).toBe(p.hash);
    const swapped = voteHash({ ...p, signal: p.outcome, outcome: p.signal });
    if (p.signal !== p.outcome) expect(swapped).not.toBe(p.hash);
  });
});

describe('raw governance objects (ZMQ rawgovernanceobject, recorded on mainnet)', () => {
  const f = objectsFixture();

  it('parses all 28 proposals; hash, re-serialization and @govhub/verify agree', () => {
    expect(f.objects.length).toBe(28);
    for (const o of f.objects) {
      const p = parseRawGovObject(hexToBytes(o.rawHex));
      expect(p.hash).toBe(o.hash);
      expect(p.type).toBe(1);
      expect(p.collateralHash).toBe(o.collateralTxid);
      expect(p.sig.length).toBe(0);
      expect(bytesToHex(serializeGovObject(p))).toBe(o.rawHex);
      expect(governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).display).toBe(o.hash);
    }
  });

  it('rejects trailing bytes', () => {
    const raw = hexToBytes(f.objects[0]!.rawHex);
    expect(() => parseRawGovObject(Uint8Array.from([...raw, 1]))).toThrow(/trailing/);
  });

  it('hash body of hashblock/hashchainlock is display order', () => {
    const h = '00'.repeat(31) + 'ff';
    expect(parseHashBody(hexToBytes(h))).toBe(h);
    expect(() => parseHashBody(new Uint8Array(31))).toThrow();
  });
});

describe('governance.dat (trimmed copy of the CT 164 mainnet file)', () => {
  const file = readFileSync(join(FIXTURES, 'governance-trimmed.dat'));

  it('parses the trigger with its signed votes; the trigger hash (outpoint + BLS signature) recomputes', () => {
    const g = parseGovernanceDat(file);
    expect(g.network).toBe('mainnet');
    expect(g.version).toBe('CGovernanceManager-Version-16');
    expect(g.objects.length).toBe(1);
    const o = g.objects[0]!;
    expect(o.object.type).toBe(2);
    expect(o.object.hash).toBe('20a49169e2249ad279ca29c9fec1f51b37b29b7455d5bd932163a556f53712d9');
    expect(govObjectHash(o.object)).toBe(o.object.hash);
    expect(o.object.sig.length).toBe(96);
    expect(o.votes.length).toBe(5);
    for (const v of o.votes) {
      expect(v.parentHash).toBe(o.object.hash);
      expect(v.sig.length).toBe(96);
      expect(parseRawVote(v.raw).hash).toBe(v.hash);
    }
  });

  it('rejects a corrupted file (checksum) and a wrong magic', () => {
    const bad = Uint8Array.from(file);
    bad[40] = bad[40]! ^ 1;
    expect(() => parseGovernanceDat(bad)).toThrow(/checksum/);
    const body = Uint8Array.from(file.subarray(0, file.length - 32));
    body[1] = 'X'.charCodeAt(0);
    const tampered = new Uint8Array([...body, ...sha256d(body)]);
    expect(() => parseGovernanceDat(tampered)).toThrow(/magic/);
  });
});
