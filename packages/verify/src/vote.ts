// Governance votes signed with the masternode VOTING key (funding votes on proposals).
// Sources: src/governance/vote.h:18-39 (enums), :166-172 (GetSignatureString), :183-186 (GetSignatureHash), :196 (serialization
// order), src/governance/vote.cpp:164-190 (CheckSignature picks the scheme by network), :211-240 (IsValid), src/rpc/governance.cpp:861-933 (voteraw).
import { base64 } from '@scure/base';
import { p2pkhAddress, type Network } from './address.ts';
import { bytesEqual, concatBytes, i32le, i64le, sha256d, u32le, uint256FromDisplay } from './bytes.ts';
import { dashMessageHash, decodeSignature, recoverCompactHash, signCompactHash, type RecoverOptions, type RecoveredKey } from './message.ts';

/** vote_signal_enum_t */
export const VOTE_SIGNAL = { NONE: 0, FUNDING: 1, VALID: 2, DELETE: 3, ENDORSED: 4 } as const;
/** vote_outcome_enum_t */
export const VOTE_OUTCOME = { NONE: 0, YES: 1, NO: 2, ABSTAIN: 3 } as const;
/** Strings accepted by `voteraw` / printed by `gobject getcurrentvotes`. */
export const VOTE_SIGNAL_NAMES = ['none', 'funding', 'valid', 'delete', 'endorsed'] as const;
export const VOTE_OUTCOME_NAMES = ['none', 'yes', 'no', 'abstain'] as const;

export interface VoteFields {
  /** Masternode collateral outpoint txid, DISPLAY hex (as in ProRegTx `collateralHash`/`gobject getcurrentvotes`). */
  collateralTxid: string;
  collateralIndex: number;
  /** Proposal (parent) hash, DISPLAY hex. */
  govHashDisplay: string;
  signal: number;
  outcome: number;
  /** unix seconds; Core rejects votes with time > now + 1h (CGovernanceVote::IsValid). */
  time: number | bigint;
}

/**
 * Which pre-image Core verifies for votes on a given network (vote.cpp:171-181):
 *  - testnet ("test"): `CHashSigner::VerifyHash(GetSignatureHash())` - the binary hash, no "DarkCoin Signed Message" wrapper
 *    (the comment in Core calls this "Harden Spork6 so that it is active on testnet and no other networks");
 *  - everything else (mainnet, regtest, devnets): `CMessageSigner::VerifyMessage(GetSignatureString())`.
 */
export type VoteScheme = 'message' | 'hash';
export const voteSchemeFor = (network: Network): VoteScheme => (network === 'testnet' ? 'hash' : 'message');
// NOTE: devnets share testnet's address prefixes but Core's check is `NetworkIDString() == "test"` exactly, so 'devnet' uses the message scheme.

/** Reason the fields cannot form a vote Core could ever count, or null. Never throws. */
export function voteFieldsError(v: VoteFields): string | null {
  if (typeof v.collateralTxid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v.collateralTxid)) return 'collateralTxid must be 64 hex chars';
  if (typeof v.govHashDisplay !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v.govHashDisplay)) return 'govHashDisplay must be 64 hex chars';
  if (!Number.isInteger(v.collateralIndex) || v.collateralIndex < 0 || v.collateralIndex > 0xffffffff) return 'collateralIndex out of range';
  // CGovernanceObject::ProcessVote rejects VOTE_SIGNAL_NONE (object.cpp:400); IsValid allows outcome NONE (vote.cpp:224).
  if (!Number.isInteger(v.signal) || v.signal < VOTE_SIGNAL.FUNDING || v.signal > VOTE_SIGNAL.ENDORSED) return 'invalid vote signal';
  if (!Number.isInteger(v.outcome) || v.outcome < VOTE_OUTCOME.NONE || v.outcome > VOTE_OUTCOME.ABSTAIN) return 'invalid vote outcome';
  try {
    const t = BigInt(v.time);
    if (t < -(1n << 63n) || t >= 1n << 63n) return 'time out of int64 range';
  } catch {
    return 'time must be an integer';
  }
  return null;
}

function checkVoteFields(v: VoteFields): void {
  const err = voteFieldsError(v);
  if (err) throw new Error(err);
}

/**
 * CGovernanceVote::GetSignatureString():
 *   "<collateral txid>-<index>|<proposal hash>|<signal>|<outcome>|<time>"
 * hashes in display (reversed) hex, lowercase; all numbers decimal ints (the signal/outcome enums, not their names).
 * Funding yes at t=1700000000 on index 0 looks like  `ab..ab-0|cd..cd|1|1|1700000000`.
 */
export function voteSignatureString(v: VoteFields): string {
  checkVoteFields(v);
  return `${v.collateralTxid.toLowerCase()}-${v.collateralIndex}|${v.govHashDisplay.toLowerCase()}|${v.signal}|${v.outcome}|${BigInt(v.time)}`;
}

/**
 * CGovernanceVote::GetSignatureHash() = SerializeHash(vote) with SER_GETHASH (the signature is skipped):
 *   outpoint.hash (32 raw) | outpoint.n (u32) | nParentHash (32 raw) | nVoteOutcome (i32) | nVoteSignal (i32) | nTime (i64)
 * NOTE the order: OUTCOME before SIGNAL, as in SERIALIZE_METHODS (vote.h:196). SHA256d of that. Used on testnet only.
 */
export function voteSignatureHash(v: VoteFields): Uint8Array {
  checkVoteFields(v);
  return sha256d(concatBytes(uint256FromDisplay(v.collateralTxid), u32le(v.collateralIndex), uint256FromDisplay(v.govHashDisplay), i32le(v.outcome), i32le(v.signal), i64le(v.time)));
}

/** The 32 bytes that are ECDSA-signed for this vote on `network`. */
export function voteSigningHash(v: VoteFields, network: Network): Uint8Array {
  return voteSchemeFor(network) === 'hash' ? voteSignatureHash(v) : dashMessageHash(voteSignatureString(v));
}

export interface SignedVote {
  /** 65-byte compact recoverable signature. */
  signature: Uint8Array;
  /** Base64 of `signature`: the `vote-sig` argument of `voteraw`. */
  base64: string;
  scheme: VoteScheme;
  /** For `scheme === 'message'`, the exact string to paste into `signmessage` (offline signing). */
  message?: string;
  /** The hash that was signed. */
  signingHash: Uint8Array;
  /** P2PKH address of the signing key (voting address). */
  signerAddress: string;
  signerKeyId: Uint8Array;
}

export interface SignVoteOptions {
  privKey: Uint8Array;
  vote: VoteFields;
  network: Network;
  /** Default true. */
  compressed?: boolean;
}

/** Signs a vote with the voting key for the given network's scheme. */
export function signVote({ privKey, vote, network, compressed = true }: SignVoteOptions): SignedVote {
  const scheme = voteSchemeFor(network);
  const signingHash = voteSigningHash(vote, network);
  const signature = signCompactHash(signingHash, privKey, { compressed });
  const rec = recoverCompactHash(signingHash, signature);
  if (!rec) throw new Error('internal error: freshly produced signature does not recover');
  return {
    signature,
    base64: base64.encode(signature),
    scheme,
    ...(scheme === 'message' ? { message: voteSignatureString(vote) } : {}),
    signingHash,
    signerAddress: p2pkhAddress(rec.keyId, network),
    signerKeyId: rec.keyId,
  };
}

export interface VoteSigner extends RecoveredKey {
  address: string;
  scheme: VoteScheme;
}

/**
 * Recovers who signed a vote. The caller must compare `keyId` with `keyIDVoting` of the ProRegTx/SML entry whose collateral
 * outpoint is `collateralTxid:collateralIndex` (hash160 of the compressed pubkey). Returns null for an unrecoverable signature.
 */
export function recoverVoteSigner(signature: string | Uint8Array, vote: VoteFields, network: Network, opts: RecoverOptions = {}): VoteSigner | null {
  if (voteFieldsError(vote)) return null; // untrusted input: report "no signer", never throw
  const sig = decodeSignature(signature);
  if (!sig) return null;
  const rec = recoverCompactHash(voteSigningHash(vote, network), sig, opts);
  if (!rec) return null;
  return { ...rec, address: p2pkhAddress(rec.keyId, network), scheme: voteSchemeFor(network) };
}

/** True iff the signature recovers to `expectedKeyId` (20-byte hash160, e.g. `keyIDVoting`). */
export function verifyVoteSignature(signature: string | Uint8Array, vote: VoteFields, expectedKeyId: Uint8Array, network: Network, opts: RecoverOptions = {}): boolean {
  const signer = recoverVoteSigner(signature, vote, network, opts);
  return signer !== null && bytesEqual(signer.keyId, expectedKeyId);
}
