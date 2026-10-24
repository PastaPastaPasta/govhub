// Real testnet votes, as dashd v24 published them on ZMQ (fixtures/testnet-votes.json, recorded by
// services/bridge/scripts/record-testnet-votes.ts). Testnet is the one network where Core verifies the binary
// GetSignatureHash() instead of a signed message (vote.cpp CheckSignature: NetworkIDString() == "test"), so these are the
// only vectors for that path that come from Core rather than from our own signVote.
// One of them (SIGNED_BY_US) is the other direction: an ABSTAIN signed with this package's signVote, submitted with
// `voteraw`, accepted by Core ("Voted successfully") and relayed back on ZMQ.
import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, decodeAddress, hexToBytes, i32le, i64le, recoverVoteSigner, sha256d, u32le, uint256ToDisplay, verifyVoteSignature, voteSignatureHash, type VoteFields } from '../src/index.ts';
import { fixture } from './helpers.ts';

const SIGNED_BY_US = '22b24d1b6fe0bad0299d7ccde8913d9ca9a10fdaceced633aae7864ff97fec11';
const fx = fixture<{ height: number; votes: Array<{ hash: string; govHash: string; rawHex: string; proTxHash: string; votingAddress: string }> }>('testnet-votes.json');

// CGovernanceVote SER_NETWORK: outpoint (txid 32 raw | n u32) | nParentHash 32 raw | nVoteOutcome i32 | nVoteSignal i32 |
// nTime i64 | vchSig (compact size + bytes)   (vote.h SERIALIZE_METHODS)
function parseRaw(rawHex: string) {
  const raw = hexToBytes(rawHex);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fields: VoteFields = {
    collateralTxid: uint256ToDisplay(raw.subarray(0, 32)),
    collateralIndex: dv.getUint32(32, true),
    govHashDisplay: uint256ToDisplay(raw.subarray(36, 68)),
    outcome: dv.getInt32(68, true),
    signal: dv.getInt32(72, true),
    time: dv.getBigInt64(76, true),
  };
  const sigLen = raw[84]!;
  return { raw, fields, preimage: raw.subarray(0, 84), sigLen, signature: raw.subarray(85, 85 + sigLen), trailing: raw.length - 85 - sigLen };
}

describe(`testnet votes signed by Dash Core (${fx.votes.length} recorded at height ${fx.height})`, () => {
  it('fixture is non-trivial', () => {
    expect(fx.votes.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fx.votes.map((v) => v.proTxHash)).size).toBeGreaterThanOrEqual(10);
  });
  it('includes the vote signed by signVote that Core accepted', () => {
    const v = fx.votes.find((x) => x.hash === SIGNED_BY_US)!;
    expect(parseRaw(v.rawHex).fields.outcome).toBe(3); // ABSTAIN
  });

  for (const v of fx.votes) {
    it(`${v.hash.slice(0, 12)} by ${v.votingAddress}`, () => {
      const { fields, preimage, sigLen, signature, trailing } = parseRaw(v.rawHex);
      expect(sigLen).toBe(65);
      expect(trailing).toBe(0);
      expect(fields.govHashDisplay).toBe(v.govHash);

      // our signing hash is Core's SerializeHash(vote) with SER_GETHASH: the network bytes minus the signature
      expect(bytesToHex(voteSignatureHash(fields))).toBe(bytesToHex(sha256d(preimage)));
      // and the fields are parsed right: they rebuild Core's vote hash (UpdateHash: dummy CTxIn bytes, SIGNAL before OUTCOME)
      const op = preimage.subarray(0, 36);
      const voteHash = sha256d(concatBytes(op, new Uint8Array([0]), u32le(0xffffffff), preimage.subarray(36, 68), i32le(fields.signal), i32le(fields.outcome), i64le(fields.time)));
      expect(uint256ToDisplay(voteHash)).toBe(v.hash);

      // the signature recovers to the voting key Core lists for this masternode, with the testnet scheme
      const keyId = decodeAddress(v.votingAddress, 'testnet')!.hash160;
      const signer = recoverVoteSigner(signature, fields, 'testnet')!;
      expect(signer.scheme).toBe('hash');
      expect(signer.address).toBe(v.votingAddress);
      expect(verifyVoteSignature(signature, fields, keyId, 'testnet')).toBe(true);

      // the message scheme (mainnet, regtest, devnets) does not verify a testnet vote
      expect(verifyVoteSignature(signature, fields, keyId, 'devnet')).toBe(false);
      // and every signed field is bound
      const flipped = fields.outcome === 1 ? 2 : 1;
      expect(verifyVoteSignature(signature, { ...fields, outcome: flipped }, keyId, 'testnet')).toBe(false);
      expect(verifyVoteSignature(signature, { ...fields, time: BigInt(fields.time) + 1n }, keyId, 'testnet')).toBe(false);
    });
  }
});
