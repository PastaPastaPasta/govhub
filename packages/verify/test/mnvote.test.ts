import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeAddress,
  governanceVoteHash,
  hexToBytes,
  parseProRegTx,
  payoutScriptAddress,
  recoverVoteSigner,
  relayCancelMessage,
  relayVoteError,
  signMessage,
  uint256ToDisplay,
  verifyRelayCancel,
  voteRawParams,
  VOTE_OUTCOME,
  VOTE_SIGNAL,
  hash160,
  type VoteFields,
} from '../src/index.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { fixture } from './helpers.ts';

const mainnetVotes = JSON.parse(readFileSync(new URL('../../../services/bridge/test/fixtures/mainnet-votes.json', import.meta.url), 'utf8'));

function parseRawVote(rawHex: string): { v: VoteFields; sig: Uint8Array } {
  const b = hexToBytes(rawHex);
  const dv = new DataView(b.buffer, b.byteOffset);
  const v: VoteFields = {
    collateralTxid: uint256ToDisplay(b.slice(0, 32)),
    collateralIndex: dv.getUint32(32, true),
    govHashDisplay: uint256ToDisplay(b.slice(36, 68)),
    outcome: dv.getInt32(68, true),
    signal: dv.getInt32(72, true),
    time: dv.getBigInt64(76, true),
  };
  const len = b[84]!;
  return { v, sig: b.slice(85, 85 + len) };
}

describe('governanceVoteHash (vote.cpp UpdateHash)', () => {
  const votes = (mainnetVotes.proposals as Array<{ votes: Array<{ hash: string; rawHex: string }> }>).flatMap((p) => p.votes).slice(0, 300);
  it('reproduces the hash of real mainnet votes', () => {
    expect(votes.length).toBeGreaterThan(100);
    for (const r of votes) expect(governanceVoteHash(parseRawVote(r.rawHex).v)).toBe(r.hash);
  });
  it('the recorded votes recover with the message scheme (sanity of the parser)', () => {
    const { v, sig } = parseRawVote(votes[0]!.rawHex);
    expect(recoverVoteSigner(sig, v, 'mainnet')).not.toBeNull();
  });
  it('differs from the signature hash order (signal before outcome)', () => {
    const v: VoteFields = { collateralTxid: 'ab'.repeat(32), collateralIndex: 1, govHashDisplay: 'cd'.repeat(32), signal: 1, outcome: 2, time: 1 };
    expect(governanceVoteHash(v)).not.toBe(governanceVoteHash({ ...v, signal: 2, outcome: 1 }));
  });
});

describe('voteRawParams / relayVoteError', () => {
  const v: VoteFields = { collateralTxid: 'AB'.repeat(32), collateralIndex: 7, govHashDisplay: 'cd'.repeat(32), signal: VOTE_SIGNAL.FUNDING, outcome: VOTE_OUTCOME.ABSTAIN, time: 1_800_000_000 };
  it('builds the voteraw arguments', () => {
    expect(voteRawParams(v, 'SIG')).toEqual(['ab'.repeat(32), 7, 'cd'.repeat(32), 'funding', 'abstain', 1_800_000_000, 'SIG']);
  });
  it('enforces funding-only, yes/no/abstain and the hold horizon', () => {
    expect(relayVoteError(v, 1_800_000_000, 3600)).toBeNull();
    expect(relayVoteError({ ...v, signal: VOTE_SIGNAL.VALID }, 1_800_000_000, 3600)).toMatch(/funding/);
    expect(relayVoteError({ ...v, outcome: VOTE_OUTCOME.NONE }, 1_800_000_000, 3600)).toMatch(/outcome/);
    expect(relayVoteError({ ...v, time: 1_800_003_601 }, 1_800_000_000, 3600)).toMatch(/ahead/);
    expect(relayVoteError({ ...v, time: 0 }, 1_800_000_000, 3600)).toMatch(/positive/);
    expect(relayVoteError({ ...v, collateralTxid: 'xx' }, 1_800_000_000, 3600)).toMatch(/collateralTxid/);
  });
});

describe('relay cancel message', () => {
  const priv = hexToBytes('33'.repeat(32));
  const keyId = hash160(secp256k1.getPublicKey(priv, true));
  const vh = 'ef'.repeat(32);
  it('has the documented shape', () => {
    expect(relayCancelMessage('testnet', vh.toUpperCase())).toBe(`govhub-relay-cancel-v1\ntestnet\n${vh}`);
    expect(() => relayCancelMessage('mainnet', 'zz')).toThrow();
  });
  it('verifies with the voting key only, and only on its network', () => {
    for (const net of ['mainnet', 'testnet'] as const) {
      const sig = signMessage(priv, relayCancelMessage(net, vh));
      expect(verifyRelayCancel(sig, net, vh, keyId)).toBe(true);
      expect(verifyRelayCancel(sig, net === 'mainnet' ? 'testnet' : 'mainnet', vh, keyId)).toBe(false);
      expect(verifyRelayCancel(sig, net, '00'.repeat(32), keyId)).toBe(false);
      expect(verifyRelayCancel(sig, net, vh, new Uint8Array(20))).toBe(false);
      expect(verifyRelayCancel('not base64!', net, vh, keyId)).toBe(false);
    }
  });
});

describe('parseProRegTx (real testnet ProRegTxs)', () => {
  const fx = fixture('protx.testnet.json').protx as Array<{ proTxHash: string; raw: string; collateralHash: string; collateralIndex: number; type: string; payoutAddress: string | null; votingAddress: string }>;
  it('recomputes the proTxHash and resolves the collateral outpoint like protx list', () => {
    expect(fx.length).toBe(4);
    for (const e of fx) {
      const p = parseProRegTx(e.raw);
      expect(p.proTxHash).toBe(e.proTxHash);
      expect(p.collateralTxid).toBe(e.collateralHash);
      expect(p.collateralIndex).toBe(e.collateralIndex);
      expect(p.mnType).toBe(e.type === 'Evo' ? 1 : 0);
    }
    // one of them carries its collateral inside the ProRegTx (null hash in the payload)
    expect(fx.some((e) => e.collateralHash === e.proTxHash)).toBe(true);
  });
  it('reads the registered payout and voting key for ProTx v1/v2 (a ProUpRegTx can change both later)', () => {
    let samePayout = 0;
    for (const e of fx) {
      const p = parseProRegTx(e.raw);
      if (p.version >= 3) {
        expect(p.registered).toBeUndefined();
        continue;
      }
      const addr = payoutScriptAddress(p.registered!.payoutScript, 'testnet');
      expect(addr).toMatch(/^[yn8]/);
      if (addr === e.payoutAddress) samePayout++;
      // for these masternodes the registered voting key is still the current one
      expect(bytesToHex(p.registered!.keyIdVoting)).toBe(bytesToHex(decodeAddress(e.votingAddress, 'testnet')!.hash160));
    }
    // 9cb04f27's payout was changed by a ProUpRegTx after registration; the others still pay the registered script
    expect(samePayout).toBe(2);
  });
  it('refuses other transactions and truncated payloads', () => {
    expect(() => parseProRegTx(fx[0]!.raw.slice(0, 200))).toThrow();
    const raw = hexToBytes(fx[0]!.raw);
    raw[2] = 2; // nType -> ProUpServTx
    expect(() => parseProRegTx(raw)).toThrow(/ProRegTx/);
  });
});
