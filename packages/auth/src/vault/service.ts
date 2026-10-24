// The passkey vault on Platform: seal the session into a `forum.vault` entry, open it again with the passkey, and the chain check
// that makes an opened bundle trustworthy (Yappr PASSKEY_VAULT.md section 4, minus App Connect).
//
// Planted entries: HPKE authenticates nobody, so whoever held any key of the owner identity could have written an entry sealed to
// this passkey's (public) recipient key. Nothing from an opened bundle is used until it is checked against the owner's keys, read
// fresh with proofs: a seed must derive an enabled HIGH/CRITICAL authentication key of the owner at its identity index; a key must
// BE such a key, with the id, level and point on chain. Only then does a session exist.
import { identifierBytes } from '../bytes.ts';
import { KeyType, SecurityLevel } from '../keys.ts';
import type { PlatformPort, VaultEntryDoc } from '../platform.ts';
import { SeedWallet } from '../seed.ts';
import { checkSessionKey, makeSession, pickSeedKey, SignInError, type Session } from '../signin.ts';
import { BundleFormat, openEntry, sealEntry, wipeBundle, type VaultBundle } from './bundle.ts';
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
 * Writes (or replaces) the entry for `credentialId`, sealed to the recipient key derived from `prfOutput` in THIS tab (a stored
 * recipient key is never trusted). Signed with the session key.
 */
export async function storeInVault(ctx: VaultContext, s: Session, credentialId: Uint8Array, recipientKey: Uint8Array): Promise<void> {
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
      const keys = await ctx.platform.identityKeys(identityId);
      const picked = keys && pickSeedKey(wallet, bundle.identityIndex, keys);
      if (!picked) {
        wallet.wipe();
        throw new SignInError("The key in this passkey doesn't control the identity it names. Remove this passkey and add it again from a trusted device.");
      }
      return makeSession({ network, identityId, identityIndex: bundle.identityIndex, keyId: picked.key.id, securityLevel: picked.key.securityLevel, source: 'passkey', privateKey: picked.privateKey, wallet });
    }
    if (bundle.format === BundleFormat.KEY) {
      const onChain = await checkSessionKey(ctx.platform, identityId, bundle.key.keyId, bundle.key.privateKey).catch(() => null);
      if (!onChain || onChain.securityLevel !== bundle.key.securityLevel) {
        throw new SignInError("The key in this passkey isn't an active key of the identity any more. Remove this passkey and add it again.");
      }
      const privateKey = bundle.key.privateKey.slice();
      return makeSession({ network, identityId, identityIndex: null, keyId: onChain.id, securityLevel: onChain.securityLevel, source: 'passkey', privateKey, wallet: null });
    }
    throw new VaultError('This passkey holds masternode voting keys, not a sign-in.');
  } finally {
    wipeBundle(bundle);
  }
}

export const listPasskeys = (ctx: VaultContext, identityId: string): Promise<VaultEntryDoc[]> => ctx.platform.vault.list(ctx.contractId, identityId);

export async function removePasskey(ctx: VaultContext, s: Session, entry: VaultEntryDoc): Promise<void> {
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
};
