// Sign-in: from a seed (discovery like DashPay iOS / Yappr, key probing like Evo Tool) or from a pasted key (EvoVote-style).
// A session signs with the identity's HIGH authentication key, else its CRITICAL one; never MASTER (PLAN r3.2 4.1).
import { hash160, wipe } from './bytes.ts';
import { isLoginKey, parsePrivateKey, privateKeyMatches, publicKeyOf, SecurityLevel, type IdentityKeyInfo, type Network } from './keys.ts';
import { CREATE_KEYS, LATER_KEYS, MASTER_KEY_ID, type KeySpec } from './layout.ts';
import type { PlatformPort, SigningKey } from './platform.ts';
import { IDENTITY_GAP_LIMIT, KEY_PROBE_LIMIT, SeedWallet } from './seed.ts';

export type SessionSource = 'seed' | 'key' | 'passkey';

/**
 * A signed-in identity. The private key lives in memory only; `wallet` is present for seed sessions (it can derive MASTER for key
 * additions and the funding keys for top-ups). `end()` wipes both.
 */
export interface Session {
  readonly network: Network;
  readonly identityId: string;
  readonly identityIndex: number | null;
  readonly keyId: number;
  readonly securityLevel: number;
  readonly source: SessionSource;
  readonly privateKey: Uint8Array;
  readonly wallet: SeedWallet | null;
  end(): void;
}

export function makeSession(o: Omit<Session, 'end'>): Session {
  return {
    ...o,
    end() {
      wipe(o.privateKey);
      o.wallet?.wipe();
    },
  };
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

export interface FoundIdentity {
  identityIndex: number;
  identityId: string;
}

/**
 * The seed's identities, as DashPay iOS, rs-platform-wallet and Yappr discover them: identity index 0, 1, ... by the hash of its
 * key-0 (MASTER) public key, stopping after IDENTITY_GAP_LIMIT unused indexes in a row. A failed lookup throws: an unanswered
 * query never reads as "no identity".
 */
export async function discoverIdentities(wallet: SeedWallet, platform: PlatformPort, o: { gap?: number; signal?: AbortSignal } = {}): Promise<FoundIdentity[]> {
  const found: FoundIdentity[] = [];
  const gap = o.gap ?? IDENTITY_GAP_LIMIT;
  for (let identityIndex = 0, misses = 0; misses < gap; identityIndex++) {
    o.signal?.throwIfAborted();
    const k = wallet.identityKey(identityIndex, 0);
    wipe(k.privateKey);
    const identityId = await platform.identityByUniqueKeyHash(hash160(k.publicKey));
    if (identityId) {
      found.push({ identityIndex, identityId });
      misses = 0;
    } else misses++;
  }
  return found;
}

/**
 * The key a seed signs with for `identityId`: derive key indexes 0..KEY_PROBE_LIMIT-1 at `identityIndex` (Evo Tool's probe, so seeds
 * whose key ids differ from their indexes still work) and pick the enabled HIGH login key it holds, else the CRITICAL one.
 */
export function pickSeedKey(wallet: SeedWallet, identityIndex: number, keys: readonly IdentityKeyInfo[]): { key: IdentityKeyInfo; privateKey: Uint8Array } | null {
  const candidates = keys.filter(isLoginKey).sort((a, b) => b.securityLevel - a.securityLevel); // HIGH (2) before CRITICAL (1)
  for (const key of candidates) {
    // key id = index is the layout every known wallet uses; try it first, then the rest of the probe range
    const order = [key.id, ...Array.from({ length: KEY_PROBE_LIMIT }, (_, i) => i).filter((i) => i !== key.id)].filter((i) => i < KEY_PROBE_LIMIT);
    for (const index of order) {
      const d = wallet.identityKey(identityIndex, index);
      if (privateKeyMatches(d.privateKey, key)) return { key, privateKey: d.privateKey };
      wipe(d.privateKey);
    }
  }
  return null;
}

/** Signs in with a seed for one discovered identity. The session takes ownership of `wallet`. */
export async function signInWithSeed(wallet: SeedWallet, found: FoundIdentity, platform: PlatformPort, source: SessionSource = 'seed'): Promise<Session> {
  const keys = await platform.identityKeys(found.identityId);
  if (!keys) throw new SignInError("This identity couldn't be found. Try again in a moment.");
  const picked = pickSeedKey(wallet, found.identityIndex, keys);
  if (!picked) throw new SignInError('This recovery phrase holds no HIGH or CRITICAL authentication key of this identity.');
  return makeSession({
    network: wallet.network,
    identityId: found.identityId,
    identityIndex: found.identityIndex,
    keyId: picked.key.id,
    securityLevel: picked.key.securityLevel,
    source,
    privateKey: picked.privateKey,
    wallet,
  });
}

export interface KeyMatch {
  identityId: string;
  keyId: number;
  securityLevel: number;
}

/**
 * The identities a pasted key can sign in to: only the public key hash is sent (unique lookup first, then non-unique), and the key
 * must be an enabled HIGH or CRITICAL authentication key of the identity. MASTER keys are refused with a clear message.
 */
export async function findKeyIdentities(privateKey: Uint8Array, platform: PlatformPort): Promise<KeyMatch[]> {
  const h = hash160(publicKeyOf(privateKey));
  const unique = await platform.identityByUniqueKeyHash(h);
  const ids = unique ? [unique] : await platform.identitiesByNonUniqueKeyHash(h);
  const out: KeyMatch[] = [];
  let sawMaster = false;
  for (const identityId of ids) {
    const keys = (await platform.identityKeys(identityId)) ?? [];
    for (const k of keys) {
      if (!privateKeyMatches(privateKey, k)) continue;
      if (isLoginKey(k)) out.push({ identityId, keyId: k.id, securityLevel: k.securityLevel });
      else if (k.securityLevel === SecurityLevel.MASTER) sawMaster = true;
    }
  }
  if (!out.length) {
    throw new SignInError(
      sawMaster
        ? 'That is a MASTER key. Sign in with the HIGH or CRITICAL authentication key instead, and keep the MASTER key offline.'
        : 'No identity has an active HIGH or CRITICAL authentication key matching this key.',
    );
  }
  return out;
}

/** Key-paste sign-in. Parses WIF or hex, finds the identity, returns an in-memory session (the caller decides about storage). */
export async function signInWithKey(input: string, platform: PlatformPort, pick?: (m: KeyMatch[]) => KeyMatch): Promise<Session> {
  const privateKey = parsePrivateKey(input, platform.network);
  try {
    const matches = await findKeyIdentities(privateKey, platform);
    const m = pick ? pick(matches) : matches[0]!;
    return makeSession({ network: platform.network, identityId: m.identityId, identityIndex: null, keyId: m.keyId, securityLevel: m.securityLevel, source: 'key', privateKey, wallet: null });
  } catch (e) {
    wipe(privateKey);
    throw e;
  }
}

/**
 * Adds the on-demand keys (3 TRANSFER, 4/5 DashPay ENC/DEC bound to `contactRequest`; layout.ts) with one IdentityUpdate signed by
 * the MASTER key, at their DIP-13 indexes so other wallets restore them. Needs a seed session. Keys already present are skipped
 * (and must be the seed's); returns the ids added.
 */
export async function addLaterKeys(s: Session, platform: PlatformPort, which: readonly KeySpec[] = LATER_KEYS): Promise<number[]> {
  if (!s.wallet || s.identityIndex === null) throw new SignInError('Adding keys needs your recovery phrase (the MASTER key signs the update).');
  const onChain = await platform.identityKeys(s.identityId);
  if (!onChain) throw new SignInError("This identity couldn't be found.");
  const idx = s.identityIndex;
  const master = s.wallet.identityKey(idx, MASTER_KEY_ID);
  const keys: SigningKey[] = [];
  try {
    const m = onChain.find((k) => k.id === MASTER_KEY_ID);
    if (!m || m.securityLevel !== SecurityLevel.MASTER || m.disabled || !privateKeyMatches(master.privateKey, m)) throw new SignInError("This recovery phrase doesn't hold the identity's MASTER key.");
    for (const spec of which) {
      const d = s.wallet.identityKey(idx, spec.id);
      const have = onChain.find((k) => k.id === spec.id);
      if (have) {
        const same = privateKeyMatches(d.privateKey, have);
        wipe(d.privateKey);
        if (!same) throw new SignInError(`Key ${spec.id} already exists and is not this phrase's key ${spec.id}.`);
        continue;
      }
      keys.push({ ...spec, privateKey: d.privateKey });
    }
    if (keys.length) await platform.addKeys({ identityId: s.identityId, master: { ...CREATE_KEYS[MASTER_KEY_ID]!, privateKey: master.privateKey }, keys });
    return keys.map((k) => k.id);
  } finally {
    wipe(master.privateKey);
    for (const k of keys) wipe(k.privateKey);
  }
}

/** Re-checks that a session key is still an enabled login key of its identity (after a passkey open, or before signing). */
export async function checkSessionKey(platform: PlatformPort, identityId: string, keyId: number, privateKey: Uint8Array): Promise<IdentityKeyInfo> {
  const keys = await platform.identityKeys(identityId);
  const k = keys?.find((x) => x.id === keyId);
  if (!k || !isLoginKey(k) || !privateKeyMatches(privateKey, k)) throw new SignInError('This key is not an active HIGH or CRITICAL authentication key of the identity.');
  return k;
}
