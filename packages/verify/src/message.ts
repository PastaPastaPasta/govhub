// Dash `signmessage` format. Source: src/util/message.cpp:25 (MESSAGE_MAGIC), :74-79 (MessageHash), src/messagesigner.cpp:25-50 and :91-103
// (CMessageSigner / CHashSigner), src/key.cpp:254-275 (CKey::SignCompact), src/pubkey.cpp:199-217 (CPubKey::RecoverCompact).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64 } from '@scure/base';
import { decodeAddress, decodeWif, p2pkhAddress, type Network } from './address.ts';
import { bytesEqual, bytesToHex, concatBytes, hash160, serializeString, sha256d, utf8ToBytes } from './bytes.ts';

/** `const std::string MESSAGE_MAGIC = "DarkCoin Signed Message:\n"` (25 bytes; the name is a Dash legacy, not a typo). */
export const MESSAGE_MAGIC = 'DarkCoin Signed Message:\n';

/**
 * Hash that is actually signed: SHA256d( CompactSize(25) || magic || CompactSize(len(msg)) || msg ).
 * Both strings are serialized as std::string (CompactSize length prefix), unlike Bitcoin's compact-size-less variants.
 * `message` is hashed as its UTF-8 bytes (what the RPC passes through).
 */
export function dashMessageHash(message: string | Uint8Array): Uint8Array {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
  return sha256d(concatBytes(serializeString(utf8ToBytes(MESSAGE_MAGIC)), serializeString(msg)));
}

/** Half the secp256k1 group order, for the low-S test. */
const HALF_ORDER = secp256k1.Point.CURVE().n >> 1n;

export interface SignOptions {
  /** Whether the public key is compressed (header +4). Default true; Dash addresses from modern wallets are all compressed. */
  compressed?: boolean;
}

/**
 * CKey::SignCompact: 65 bytes = header || r(32) || s(32) with header = 27 + recid + (compressed ? 4 : 0).
 * Deterministic RFC 6979 nonce and low-S, exactly like libsecp256k1's default - signatures are byte-identical to Core's.
 */
export function signCompactHash(hash32: Uint8Array, privKey: Uint8Array, opts: SignOptions = {}): Uint8Array {
  if (hash32.length !== 32) throw new Error('hash must be 32 bytes');
  const compressed = opts.compressed ?? true;
  // noble 'recovered' format = recid || r || s (recid FIRST), lowS is enforced by default.
  const rec = secp256k1.sign(hash32, privKey, { prehash: false, format: 'recovered', lowS: true });
  const recid = rec[0]!;
  return concatBytes(Uint8Array.of(27 + recid + (compressed ? 4 : 0)), rec.subarray(1));
}

export interface RecoverOptions {
  /**
   * Core's RecoverCompact accepts ANY header byte (it only looks at (h-27)&3 and (h-27)&4) and high-S. Votes are checked
   * that way, so the default is to accept them as well. `strict` additionally requires header in 27..34 and low-S, i.e. the
   * encoding CKey::SignCompact can produce (cf. CHashSigner::VerifyHashCanonical, which Core uses for non-governance signatures).
   */
  strict?: boolean;
}

export interface RecoveredKey {
  /** 33 bytes when the header flags a compressed key, else 65 bytes. */
  pubkey: Uint8Array;
  compressed: boolean;
  /** hash160 of `pubkey` (= CKeyID; for governance votes this must equal `keyIDVoting` in the SML). */
  keyId: Uint8Array;
}

/** CPubKey::RecoverCompact. Returns null on any failure. */
export function recoverCompactHash(hash32: Uint8Array, sig: Uint8Array, opts: RecoverOptions = {}): RecoveredKey | null {
  if (hash32.length !== 32 || sig.length !== 65) return null;
  const header = sig[0]!;
  if (opts.strict) {
    if (header < 27 || header > 34) return null;
    const s = BigInt('0x' + bytesToHex(sig.subarray(33)));
    if (s > HALF_ORDER) return null;
  }
  const recid = (header - 27) & 3;
  const compressed = ((header - 27) & 4) !== 0;
  try {
    const parsed = secp256k1.Signature.fromBytes(sig.subarray(1), 'compact').addRecoveryBit(recid);
    const pubkey = parsed.recoverPublicKey(hash32).toBytes(compressed);
    return { pubkey, compressed, keyId: hash160(pubkey) };
  } catch {
    return null;
  }
}

/** `signmessage`/`signmessagewithprivkey`: 65-byte compact signature over `dashMessageHash(message)`. */
export function signMessageRaw(privKey: Uint8Array, message: string | Uint8Array, opts: SignOptions = {}): Uint8Array {
  return signCompactHash(dashMessageHash(message), privKey, opts);
}

/** Same as `signMessageRaw`, base64 encoded (the format of `signmessage` output and `voteraw` input). */
export function signMessage(privKey: Uint8Array, message: string | Uint8Array, opts: SignOptions = {}): string {
  return base64.encode(signMessageRaw(privKey, message, opts));
}

/** Convenience: sign with a WIF key; the compressed flag comes from the WIF. */
export function signMessageWif(wif: string, message: string | Uint8Array, network: Network): string {
  const { privKey, compressed } = decodeWif(wif, network);
  return signMessage(privKey, message, { compressed });
}

export function decodeSignature(sig: string | Uint8Array): Uint8Array | null {
  if (typeof sig !== 'string') return sig;
  try {
    return base64.decode(sig);
  } catch {
    return null;
  }
}

export interface MessageSigner extends RecoveredKey {
  address: string;
}

/** Recovers the signer of a Dash signed message (null if the signature is malformed / unrecoverable). */
export function recoverMessageSigner(sig: string | Uint8Array, message: string | Uint8Array, network: Network, opts: RecoverOptions = {}): MessageSigner | null {
  const bytes = decodeSignature(sig);
  if (!bytes) return null;
  const rec = recoverCompactHash(dashMessageHash(message), bytes, opts);
  if (!rec) return null;
  return { ...rec, address: p2pkhAddress(rec.keyId, network) };
}

/**
 * `verifymessage`: true iff `address` is a P2PKH address on `network` and the signature recovers to its hash160.
 * (P2SH addresses can never verify, like Core's ERR_ADDRESS_NO_KEY.)
 */
export function verifyMessage(address: string, sig: string | Uint8Array, message: string | Uint8Array, network: Network, opts: RecoverOptions = {}): boolean {
  const dest = decodeAddress(address, network);
  if (!dest || dest.type !== 'p2pkh') return false;
  const bytes = decodeSignature(sig);
  if (!bytes) return false;
  const rec = recoverCompactHash(dashMessageHash(message), bytes, opts);
  return rec !== null && bytesEqual(rec.keyId, dest.hash160);
}
