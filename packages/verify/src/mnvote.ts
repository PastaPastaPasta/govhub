// Masternode voting helpers shared by the browser (keyring, voting UI) and the relay (services/relay):
//  - the governance vote hash Core uses as a vote's id (`gobject getcurrentvotes` keys, the bridge's `votes.hash`),
//  - the Core rules a relay must respect before `voteraw`,
//  - the relay cancel message (govhub-relay-cancel-v1), signed with Dash `signmessage` by the voting key on every network,
//  - the collateral outpoint (and, for ProTx v1/v2, the registered payout script) from a ProRegTx, bound to its proTxHash.
// Sources (Dash Core develop f35a24cfca12): governance/vote.cpp:145-156 (UpdateHash), :211-216 (1 h future limit),
// governance/object.h:90 + object.cpp:443-456 (GOVERNANCE_UPDATE_MIN, "voting too often"), rpc/governance.cpp:861-938 (voteraw),
// evo/providertx.h:162-183 (CProRegTx serialization), evo/types.h:15-20 (ProTxVersion).
import { encodeAddress, p2pkhAddress, type Network } from './address.ts';
import { bytesEqual, bytesToHex, concatBytes, i32le, i64le, Reader, sha256d, u32le, uint256FromDisplay, uint256ToDisplay, hexToBytes } from './bytes.ts';
import { recoverMessageSigner, type RecoverOptions } from './message.ts';
import { parseTransaction } from './tx.ts';
import { VOTE_OUTCOME, VOTE_OUTCOME_NAMES, VOTE_SIGNAL, VOTE_SIGNAL_NAMES, voteFieldsError, type VoteFields } from './vote.ts';

/** Core rejects a vote whose nTime is more than this far ahead of its adjusted time (CGovernanceVote::IsValid). */
export const VOTE_MAX_FUTURE_S = 3600;
/** GOVERNANCE_UPDATE_MIN: one accepted vote per (masternode, object, signal) per hour, measured on the RECEIVING node's clock. */
export const VOTE_UPDATE_MIN_S = 3600;

/**
 * CGovernanceVote::UpdateHash (vote.cpp:145-156), the vote's id. NOTE: this is not the signature hash: SIGNAL comes before OUTCOME here,
 * and the outpoint is followed by the legacy `uint8 0 || u32 0xffffffff` filler.
 *   SHA256d( outpoint.hash (32 raw) | outpoint.n u32 | 0x00 | ffffffff | parentHash (32 raw) | signal i32 | outcome i32 | time i64 )
 * Returned as display hex (what `gobject getcurrentvotes` and the bridge print).
 */
export function governanceVoteHash(v: VoteFields): string {
  const err = voteFieldsError(v);
  if (err) throw new Error(err);
  const pre = concatBytes(
    uint256FromDisplay(v.collateralTxid),
    u32le(v.collateralIndex),
    Uint8Array.of(0),
    u32le(0xffffffff),
    uint256FromDisplay(v.govHashDisplay),
    i32le(v.signal),
    i32le(v.outcome),
    i64le(v.time),
  );
  return uint256ToDisplay(sha256d(pre));
}

/** The `voteraw` parameters (rpc/governance.cpp:861): txid, index, governance hash, signal name, outcome name, time, base64 signature. */
export function voteRawParams(v: VoteFields, signatureBase64: string): [string, number, string, string, string, number, string] {
  const err = voteFieldsError(v);
  if (err) throw new Error(err);
  const t = Number(v.time);
  if (!Number.isSafeInteger(t)) throw new Error('time must be a safe integer');
  return [v.collateralTxid.toLowerCase(), v.collateralIndex, v.govHashDisplay.toLowerCase(), VOTE_SIGNAL_NAMES[v.signal]!, VOTE_OUTCOME_NAMES[v.outcome]!, t, signatureBase64];
}

/**
 * Why a relay must not accept this vote, or null. Funding votes on proposals only (operator BLS signals are out of scope);
 * outcome yes/no/abstain (voteraw refuses NONE). `now` is unix seconds; `maxHoldS` bounds how far ahead a held vote's nTime may be.
 */
export function relayVoteError(v: VoteFields, now: number, maxHoldS: number): string | null {
  const err = voteFieldsError(v);
  if (err) return err;
  if (v.signal !== VOTE_SIGNAL.FUNDING) return 'only funding votes are relayed';
  if (v.outcome !== VOTE_OUTCOME.YES && v.outcome !== VOTE_OUTCOME.NO && v.outcome !== VOTE_OUTCOME.ABSTAIN) return 'outcome must be yes, no or abstain';
  const t = Number(v.time);
  if (!Number.isSafeInteger(t) || t <= 0) return 'time must be a positive unix time';
  if (t > now + maxHoldS) return `time is more than ${maxHoldS} s ahead`;
  return null;
}

// ---- relay cancel (govhub-relay-cancel-v1) ----

/** First line of every cancel message; no vote string (`<txid>-<n>|...`) can start with it. */
export const RELAY_CANCEL_DOMAIN = 'govhub-relay-cancel-v1';

/**
 * The exact text a voting key signs with Dash `signmessage` (DarkCoin message magic; the SAME scheme on mainnet and testnet, so a
 * hardware wallet or Dash Core can sign it) to drop a held vote:
 *   "govhub-relay-cancel-v1\n<network>\n<vote hash, display hex lowercase>"
 * The network line keeps a testnet cancel from being replayed on mainnet. A cancel names one vote; it is idempotent.
 */
export function relayCancelMessage(network: Network, voteHashDisplay: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(voteHashDisplay)) throw new Error('vote hash must be 64 hex chars');
  return `${RELAY_CANCEL_DOMAIN}\n${network}\n${voteHashDisplay.toLowerCase()}`;
}

/** True iff `signature` (base64 or 65 bytes) is the voting key `keyIdVoting` signing the cancel of `voteHashDisplay` on `network`. */
export function verifyRelayCancel(signature: string | Uint8Array, network: Network, voteHashDisplay: string, keyIdVoting: Uint8Array, opts: RecoverOptions = {}): boolean {
  let msg: string;
  try {
    msg = relayCancelMessage(network, voteHashDisplay);
  } catch {
    return false;
  }
  const rec = recoverMessageSigner(signature, msg, network, opts);
  return rec !== null && bytesEqual(rec.keyId, keyIdVoting);
}

// ---- ProRegTx ----

export const TRANSACTION_PROVIDER_REGISTER = 1;
export const PROTX_VERSION_EXT_ADDR = 3;

export interface ProRegTxInfo {
  /** txid of the ProRegTx = the masternode's proTxHash (display hex), recomputed from the bytes. */
  proTxHash: string;
  version: number;
  /** 0 regular, 1 evo. */
  mnType: number;
  /** The collateral outpoint as Core resolves it: a null hash in the payload means "output `collateralIndex` of the ProRegTx itself". */
  collateralTxid: string;
  collateralIndex: number;
  /** ProTx v1/v2 only: the payout script and voting key id AT REGISTRATION (a ProUpRegTx can change both later). */
  registered?: { payoutScript: Uint8Array; keyIdVoting: Uint8Array; operatorReward: number };
}

/**
 * Parses a raw ProRegTx (type 1). The proTxHash is the hash of these exact bytes, so a caller that compares it with the proTxHash of
 * a verified SML entry knows the collateral outpoint is the registered one (the collateral of a proTxHash never changes).
 * The later payload fields are read for ProTx v1/v2 only (v3 = extended addresses has a variable-length NetInfo and payout list).
 */
export function parseProRegTx(raw: Uint8Array | string): ProRegTxInfo {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  const tx = parseTransaction(bytes);
  if (tx.version < 3 || tx.type !== TRANSACTION_PROVIDER_REGISTER || !tx.extraPayload) throw new Error('not a ProRegTx');
  const r = new Reader(tx.extraPayload);
  const version = r.u16();
  if (version < 1 || version > PROTX_VERSION_EXT_ADDR) throw new Error(`unknown ProRegTx version ${version}`);
  const mnType = r.u16();
  r.u16(); // nMode
  const hashRaw = r.bytes(32).slice();
  const n = r.u32();
  const isNull = hashRaw.every((b) => b === 0);
  const info: ProRegTxInfo = {
    proTxHash: tx.txid,
    version,
    mnType,
    collateralTxid: isNull ? tx.txid : uint256ToDisplay(hashRaw),
    collateralIndex: n,
  };
  if (version < PROTX_VERSION_EXT_ADDR) {
    r.bytes(18); // CService: 16-byte address + big-endian port
    r.bytes(20); // keyIDOwner
    r.bytes(48); // pubKeyOperator
    const keyIdVoting = r.bytes(20).slice();
    const operatorReward = r.u16();
    const payoutScript = r.bytes(r.compactSize()).slice();
    info.registered = { payoutScript, keyIdVoting, operatorReward };
  }
  return info;
}

/** P2PKH / P2SH address of a standard payout script, else null. */
export function payoutScriptAddress(script: Uint8Array, network: Network): string | null {
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return p2pkhAddress(script.subarray(3, 23), network);
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return encodeAddress('p2sh', script.subarray(2, 22), network);
  }
  return null;
}

/** Hex of a 20-byte key id (for maps keyed by keyIDVoting). */
export const keyIdHex = (keyId: Uint8Array): string => bytesToHex(keyId);
