// The passkey vault on Platform: seal the session into a `forum.vault` entry, open it again with the passkey, and the chain check
// that makes an opened bundle trustworthy (Yappr PASSKEY_VAULT.md section 4, minus App Connect).
//
// Planted entries: HPKE authenticates nobody, so whoever held any key of the owner identity could have written an entry sealed to
// this passkey's (public) recipient key. Nothing from an opened bundle is used until it is checked against the owner's keys, read
// fresh with proofs: a seed must derive an enabled HIGH/CRITICAL authentication key of the owner at its identity index; a key must
// BE such a key, with the id, level and point on chain. Only then does a session exist.
import { identifierBytes, wipe } from '../bytes.ts';
import { KeyType, privateKeyMatches, SecurityLevel } from '../keys.ts';
import { MASTER_KEY_ID } from '../layout.ts';
import type { PlatformPort, VaultEntryDoc } from '../platform.ts';
import { SeedWallet } from '../seed.ts';
import { assertLive, checkSessionKey, makeSession, pickSeedKey, SignInError, type Session } from '../signin.ts';
import { BundleFormat, openEntry, recipientFromPrf, sealEntry, wipeBundle, type VaultBundle } from './bundle.ts';
import { parseUserHandle, type PasskeyAssertion } from './webauthn.ts';

export interface VaultContext {
  platform: PlatformPort;
  /** The `forum` contract id (base58) holding the `vault` type. */
  contractId: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/** The bundle a session can keep: its seed (when signed in with one), else its sign-in key. Never MASTER (sessions never hold it). */
export function bundleForSession(s: Session): VaultBundle {
  if (s.wallet && s.identityIndex !== null) return { format: BundleFormat.SEED, identityIndex: s.identityIndex, entropy: s.wallet.entropy() };
  if (s.securityLevel !== SecurityLevel.HIGH && s.securityLevel !== SecurityLevel.CRITICAL) throw new VaultError('Only a HIGH or CRITICAL key can be kept in a passkey.');
  return { format: BundleFormat.KEY, key: { keyId: s.keyId, purpose: 0, securityLevel: s.securityLevel, keyType: KeyType.ECDSA_SECP256K1, privateKey: s.privateKey.slice() } };
}

/**
 * Writes (or replaces) the entry for a passkey, sealed to the recipient key derived here from the PRF output of an assertion made in
 * THIS tab (a stored recipient key is never trusted). The assertion's user handle must name this identity and this vault. Signed with
 * the session key; refused for an ended session. Returns the recipient key (for waitForEntry).
 */
export async function storeInVault(ctx: VaultContext, s: Session, a: PasskeyAssertion): Promise<Uint8Array> {
  assertLive(s);
  const { credentialId } = a;
  if (credentialId.length < 16 || credentialId.length > 255) throw new VaultError('This passkey has an unusual credential id and cannot be used.');
  if (parseUserHandle(a.userHandle, ctx.contractId).identityId !== s.identityId) throw new VaultError('This passkey belongs to another identity.');
  const recipientKey = recipientFromPrf(a.prfOutput).publicKey;
  const bundle = bundleForSession(s);
  try {
    const sealed = sealEntry({ contractId: identifierBytes(ctx.contractId), ownerId: identifierBytes(s.identityId), credentialId, recipientKey, authKeyId: s.keyId, bundle });
    const existing = await ctx.platform.vault.byCredential(ctx.contractId, s.identityId, credentialId);
    await ctx.platform.vault.put({
      contractId: ctx.contractId,
      ownerId: s.identityId,
      key: { id: s.keyId, purpose: 0, securityLevel: s.securityLevel, type: KeyType.ECDSA_SECP256K1, privateKey: s.privateKey },
      entry: { credentialId, recipientKey, version: sealed.version, authKeyId: sealed.authKeyId, enc: sealed.enc, sealed: sealed.sealed },
      existing,
    });
    return recipientKey;
  } finally {
    wipeBundle(bundle);
  }
}

/** Waits until a proved read shows the entry sealed to `recipientKey` (nodes can lag a block). */
export async function waitForEntry(ctx: VaultContext, identityId: string, credentialId: Uint8Array, recipientKey: Uint8Array, tries = 15): Promise<VaultEntryDoc> {
  for (let i = 0; ; i++) {
    const e = await ctx.platform.vault.byCredential(ctx.contractId, identityId, credentialId).catch(() => null);
    if (e && e.recipientKey.every((b, j) => b === recipientKey[j])) return e;
    if (i >= tries) throw new VaultError('The passkey entry is not visible on Platform yet. Check again in a minute.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Sign-in with a passkey assertion: find the entry named by the passkey's user handle and credential id, open it with the PRF output,
 * check the bundle against the owner's keys on chain, and return a session (source 'passkey').
 */
export async function openVault(ctx: VaultContext, a: PasskeyAssertion): Promise<Session> {
  const { identityId } = parseUserHandle(a.userHandle, ctx.contractId);
  const entry = await ctx.platform.vault.byCredential(ctx.contractId, identityId, a.credentialId);
  if (!entry) throw new VaultError('No vault entry for this passkey. It may have been removed; sign in another way and add it again.');
  if (entry.ownerId !== identityId) throw new VaultError('The vault entry belongs to another identity.');
  const bundle = openEntry({ contractId: identifierBytes(ctx.contractId), ownerId: identifierBytes(identityId), entry, prfOutput: a.prfOutput });
  const network = ctx.platform.network;
  try {
    if (bundle.format === BundleFormat.SEED) {
      const wallet = SeedWallet.fromEntropy(bundle.entropy, network);
      let keys;
      try {
        keys = await ctx.platform.identityKeys(identityId);
      } catch (e) {
        wallet.wipe();
        throw e;
      }
      // The seed must be THE seed of this identity: its key 0 at the bundle's index is the identity's enabled MASTER key 0. A seed
      // that merely holds a HIGH key someone added (a planted entry) is refused, so a top-up can never pay to an outsider's key.
      const master = keys?.find((k) => k.id === MASTER_KEY_ID);
      const k0 = wallet.identityKey(bundle.identityIndex, MASTER_KEY_ID);
      const ownsMaster = !!master && !master.disabled && master.securityLevel === SecurityLevel.MASTER && privateKeyMatches(k0.privateKey, master);
      wipe(k0.privateKey);
      const picked = ownsMaster && keys ? pickSeedKey(wallet, bundle.identityIndex, keys) : null;
      if (!picked) {
        wallet.wipe();
        throw new SignInError("The key in this passkey doesn't control the identity it names. Remove this passkey and add it again from a trusted device.");
      }
      return makeSession({ network, identityId, identityIndex: bundle.identityIndex, keyId: picked.key.id, securityLevel: picked.key.securityLevel, source: 'passkey', privateKey: picked.privateKey, wallet, credentialId: a.credentialId.slice() });
    }
    if (bundle.format === BundleFormat.KEY) {
      // Only "not a key of this identity" is a refusal; a failed read propagates as itself.
      let onChain = null;
      try {
        onChain = await checkSessionKey(ctx.platform, identityId, bundle.key.keyId, bundle.key.privateKey);
      } catch (e) {
        if (!(e instanceof SignInError)) throw e;
      }
      if (!onChain || onChain.securityLevel !== bundle.key.securityLevel) {
        throw new SignInError("The key in this passkey isn't an active key of the identity any more. Remove this passkey and add it again.");
      }
      const privateKey = bundle.key.privateKey.slice();
      return makeSession({ network, identityId, identityIndex: null, keyId: onChain.id, securityLevel: onChain.securityLevel, source: 'passkey', privateKey, wallet: null, credentialId: a.credentialId.slice() });
    }
    throw new VaultError('This passkey holds masternode voting keys, not a sign-in.');
  } finally {
    wipeBundle(bundle);
  }
}

export const listPasskeys = (ctx: VaultContext, identityId: string): Promise<VaultEntryDoc[]> => ctx.platform.vault.list(ctx.contractId, identityId);

export async function removePasskey(ctx: VaultContext, s: Session, entry: VaultEntryDoc): Promise<void> {
  assertLive(s);
  await ctx.platform.vault.remove({
    contractId: ctx.contractId,
    ownerId: s.identityId,
    key: { id: s.keyId, purpose: 0, securityLevel: s.securityLevel, type: KeyType.ECDSA_SECP256K1, privateKey: s.privateKey },
    entry,
  });
}

/** Credential ids made in this browser (public data), so the UI can mark "this device" and treat other entries with suspicion. */
export const localPasskeys = {
  key: (identityId: string) => `govhub.passkeys.${identityId}`,
  list(storage: Pick<Storage, 'getItem'>, identityId: string): string[] {
    try {
      const v = JSON.parse(storage.getItem(this.key(identityId)) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  },
  add(storage: Pick<Storage, 'getItem' | 'setItem'>, identityId: string, credentialIdB64: string): void {
    const l = new Set(this.list(storage, identityId));
    l.add(credentialIdB64);
    storage.setItem(this.key(identityId), JSON.stringify([...l]));
  },
  /** Forgets a removed passkey; the entry goes once it lists none. */
  remove(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, identityId: string, credentialIdB64: string): void {
    const l = this.list(storage, identityId).filter((x) => x !== credentialIdB64);
    if (l.length) storage.setItem(this.key(identityId), JSON.stringify(l));
    else storage.removeItem(this.key(identityId));
  },
};
