import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { bytesToHex, concatBytes, decodeWif, dashMessageHash, hexToBytes, recoverVoteSigner, sha256d, signMessage, signVote, verifyVoteSignature, voteSchemeFor, voteSignatureHash, voteSignatureString, voteSigningHash, VOTE_OUTCOME, VOTE_SIGNAL, hash160, type VoteFields } from '../src/index.ts';
import { fixture } from './helpers.ts';

const sigs = fixture('messages.regtest.json').signatures as Array<any>;
const voteShaped = sigs.filter((s) => /^[0-9a-f]{64}-\d+\|[0-9a-f]{64}\|\d\|\d\|\d+$/.test(s.message));

function parseVote(s: string): VoteFields {
  const [outpoint, parent, signal, outcome, time] = s.split('|') as [string, string, string, string, string];
  const [txid, idx] = outpoint.split('-') as [string, string];
  return { collateralTxid: txid, collateralIndex: Number(idx), govHashDisplay: parent, signal: Number(signal), outcome: Number(outcome), time: BigInt(time) };
}

const V: VoteFields = {
  collateralTxid: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  collateralIndex: 3,
  govHashDisplay: 'aa'.repeat(31) + 'bb',
  signal: VOTE_SIGNAL.FUNDING,
  outcome: VOTE_OUTCOME.YES,
  time: 1_760_000_000,
};
const key = hexToBytes('22'.repeat(32));

describe('vote signature string', () => {
  it('has the documented shape', () => {
    expect(voteSignatureString(V)).toBe(`${V.collateralTxid}-3|${V.govHashDisplay}|1|1|1760000000`);
    expect(voteSignatureString({ ...V, collateralTxid: V.collateralTxid.toUpperCase(), outcome: VOTE_OUTCOME.ABSTAIN })).toBe(`${V.collateralTxid}-3|${V.govHashDisplay}|1|3|1760000000`);
  });
  it('validates inputs', () => {
    expect(() => voteSignatureString({ ...V, collateralTxid: 'abc' })).toThrow();
    expect(() => voteSignatureString({ ...V, govHashDisplay: 'zz'.repeat(32) })).toThrow();
    expect(() => voteSignatureString({ ...V, signal: 9 })).toThrow();
    expect(() => voteSignatureString({ ...V, outcome: 4 })).toThrow();
    expect(() => voteSignatureString({ ...V, collateralIndex: -1 })).toThrow();
  });
  it('vote-shaped strings in the Core fixtures round-trip through voteSignatureString', () => {
    expect(voteShaped.length).toBeGreaterThanOrEqual(12);
    for (const s of voteShaped) expect(voteSignatureString(parseVote(s.message))).toBe(s.message);
  });
});

describe('votes signed by Dash Core (regtest = message scheme)', () => {
  it('recoverVoteSigner returns the voting address Core signed with, and our signVote is byte-identical', () => {
    for (const s of voteShaped) {
      const v = parseVote(s.message);
      const rec = recoverVoteSigner(s.coreSigBase64, v, 'regtest')!;
      expect(rec.address).toBe(s.address);
      expect(rec.scheme).toBe('message');
      expect(bytesToHex(rec.keyId)).toBe(bytesToHex(hash160(hexToBytes(s.pubkey))));
      expect(verifyVoteSignature(s.coreSigBase64, v, rec.keyId, 'regtest')).toBe(true);
      // tampering with any signed field changes the recovered key (so it can no longer match keyIDVoting)
      expect(verifyVoteSignature(s.coreSigBase64, { ...v, outcome: v.outcome === 1 ? 2 : 1 }, rec.keyId, 'regtest')).toBe(false);
      expect(verifyVoteSignature(s.coreSigBase64, { ...v, time: BigInt(v.time) + 1n }, rec.keyId, 'regtest')).toBe(false);
      expect(verifyVoteSignature(s.coreSigBase64, { ...v, collateralIndex: v.collateralIndex + 1 }, rec.keyId, 'regtest')).toBe(false);
      const signed = signVote({ privKey: privKeyOf(s.wif), vote: v, network: 'regtest' });
      expect(signed.base64).toBe(s.coreSigBase64);
      expect(signed.message).toBe(s.message);
      expect(signed.signerAddress).toBe(s.address);
    }
  });
});

const privKeyOf = (wif: string): Uint8Array => decodeWif(wif, 'regtest').privKey;

describe('mainnet scheme: message signing', () => {
  it('signVote == signmessage over the vote string; base64 is the voteraw argument', () => {
    const s = signVote({ privKey: key, vote: V, network: 'mainnet' });
    expect(s.scheme).toBe('message');
    expect(s.base64).toBe(signMessage(key, voteSignatureString(V)));
    expect(s.signature.length).toBe(65);
    expect(base64.decode(s.base64)).toEqual(s.signature);
    expect(s.signingHash).toEqual(dashMessageHash(voteSignatureString(V)));
    expect(s.signerAddress.startsWith('X')).toBe(true);
    const rec = recoverVoteSigner(s.base64, V, 'mainnet')!;
    expect(rec.address).toBe(s.signerAddress);
    expect(rec.compressed).toBe(true);
    // the signer must be the voting key: compare hash160
    expect(verifyVoteSignature(s.signature, V, s.signerKeyId, 'mainnet')).toBe(true);
    expect(verifyVoteSignature(s.signature, V, new Uint8Array(20), 'mainnet')).toBe(false);
  });
});

describe('testnet scheme: binary GetSignatureHash (vote.cpp:171-181)', () => {
  it('network -> scheme mapping', () => {
    expect(voteSchemeFor('mainnet')).toBe('message');
    expect(voteSchemeFor('regtest')).toBe('message');
    expect(voteSchemeFor('testnet')).toBe('hash');
  });
  it('signature hash preimage: outpoint | parent | OUTCOME | SIGNAL | time, raw byte orders', () => {
    const raw = (h: string) => hexToBytes(h).reverse();
    const manual = sha256d(concatBytes(raw(V.collateralTxid), hexToBytes('03000000'), raw(V.govHashDisplay), hexToBytes('02000000'), hexToBytes('01000000'), hexToBytes(leI64(1_760_000_000))));
    // outcome NO (2) comes BEFORE signal FUNDING (1) in the serialization
    expect(bytesToHex(voteSignatureHash({ ...V, outcome: VOTE_OUTCOME.NO }))).toBe(bytesToHex(manual));
    // outcome and signal are NOT interchangeable in the preimage
    // swapping the numeric values of outcome and signal must change the hash (they sit at fixed offsets)
    const a = voteSignatureHash({ ...V, signal: VOTE_SIGNAL.FUNDING, outcome: VOTE_OUTCOME.NO });
    const b = voteSignatureHash({ ...V, signal: VOTE_SIGNAL.VALID, outcome: VOTE_OUTCOME.YES });
    expect(a).not.toEqual(b);
  });
  it('sign / recover round trip, and the two schemes do not cross-verify', () => {
    const t = signVote({ privKey: key, vote: V, network: 'testnet' });
    expect(t.scheme).toBe('hash');
    expect(t.message).toBeUndefined();
    expect(t.signingHash).toEqual(voteSignatureHash(V));
    expect(t.signerAddress.startsWith('y')).toBe(true);
    expect(recoverVoteSigner(t.signature, V, 'testnet')!.keyId).toEqual(t.signerKeyId);
    // a testnet-style signature fails against the message scheme (recovers some other key) and vice versa
    expect(verifyVoteSignature(t.signature, V, t.signerKeyId, 'mainnet')).toBe(false);
    const m = signVote({ privKey: key, vote: V, network: 'mainnet' });
    expect(verifyVoteSignature(m.signature, V, m.signerKeyId, 'testnet')).toBe(false);
    expect(voteSigningHash(V, 'testnet')).not.toEqual(voteSigningHash(V, 'mainnet'));
  });
  it('uncompressed voting keys are supported via the header flag and give a different key id', () => {
    const a = signVote({ privKey: key, vote: V, network: 'mainnet' });
    const b = signVote({ privKey: key, vote: V, network: 'mainnet', compressed: false });
    expect(a.signerAddress).not.toBe(b.signerAddress);
    expect(recoverVoteSigner(b.signature, V, 'mainnet')!.pubkey.length).toBe(65);
  });
});

function leI64(n: number): string {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b.toString('hex');
}

describe('review hardening', () => {
  it('untrusted vote fields never throw in the verify path', () => {
    const sig = signVote({ privKey: key, vote: V, network: 'mainnet' });
    const bad = [
      { ...V, collateralTxid: '' },
      { ...V, collateralIndex: -1 },
      { ...V, signal: 0 },
      { ...V, signal: 99 },
      { ...V, outcome: 7 },
      { ...V, time: 2n ** 70n },
      { ...V, govHashDisplay: 'xyz' },
    ] as VoteFields[];
    for (const b of bad) {
      expect(recoverVoteSigner(sig.signature, b, 'mainnet')).toBeNull();
      expect(verifyVoteSignature(sig.signature, b, sig.signerKeyId, 'mainnet')).toBe(false);
    }
    expect(() => voteSignatureString({ ...V, signal: VOTE_SIGNAL.NONE })).toThrow();
  });
  it('devnet uses the message scheme (Core checks NetworkIDString() == "test" exactly)', () => {
    expect(voteSchemeFor('devnet')).toBe('message');
    const s = signVote({ privKey: key, vote: V, network: 'devnet' });
    expect(s.signerAddress.startsWith('y')).toBe(true);
    expect(s.signingHash).toEqual(dashMessageHash(voteSignatureString(V)));
  });
});
