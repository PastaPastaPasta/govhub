// The masternode keyring on Platform ("add my masternodes", saved across logins): load / open / save the two `forum.keyring`
// documents of an identity. Crypto and sizes: seal.ts, format.ts. The operator never sees plaintext: everything is encrypted in
// the browser to the user's seed and passkeys before it is written.
//
// Planted documents. Any holder of a HIGH key of the identity can REPLACE the keyring with one sealed to the user's passkey (its
// recipient key is public in `forum.vault`), listing extra unlockers of their own. Re-sealing that content would leak the voting
// keys the user adds later. So:
//   - a seed session checks that the content lists THIS seed's unlocker (its public key is never published, so only someone who
//     could already open a genuine keyring can write one that lists it): `authenticated` true / false;
//   - a passkey session without the seed cannot check (`authenticated` null); the UI lists every unlocker and lets the user remove
//     ones they do not recognise before anything new is saved.
// New unlockers are only ever added from a key derived in this tab (the seed, or a PRF output from a passkey ceremony here), never
// from a recipient key read from the chain.
import { bytesEqual, identifierBytes, randomBytes, wipe } from '../bytes.ts';
import { KeyType } from '../keys.ts';
import type { SigningKey } from '../platform.ts';
import { assertLive, type Session } from '../signin.ts';
import { recipientFromPrf } from '../vault/bundle.ts';
import type { HpkeKeyPair } from '../vault/hpke.ts';
import {
  decodeKeys,
  decodePending,
  DEFAULT_IDLE_LOCK_MINUTES,
  encodeKeys,
  encodePending,
  KEYRING_ID_LENGTH,
  KeyringKind,
  MAX_UNLOCKERS,
  UnlockerType,
  wipeKeysContent,
  type KeysContent,
  type PendingContent,
  type Unlocker,
} from './format.ts';
import { openKeyring, sealKeyring, seedUnlocker, type SealedKeyring } from './seal.ts';

export interface KeyringDoc {
  id: string;
  ownerId: string;
  revision: number;
  kind: number;
  sealed: SealedKeyring;
}

/** Where keyring documents live. `createEvoKeyringStore` ('@govhub/auth/keyring-evo') is the Platform implementation. */
export interface KeyringStore {
  /** The identity's document of this kind (proved read), or null. */
  get(ownerId: string, kind: KeyringKind): Promise<KeyringDoc | null>;
  /** Creates it, or replaces `existing`. Returns the stored document's id and new revision. */
  put(o: { ownerId: string; key: SigningKey; kind: KeyringKind; sealed: SealedKeyring; existing: KeyringDoc | null }): Promise<{ id: string; revision: number }>;
  remove(o: { ownerId: string; key: SigningKey; doc: KeyringDoc }): Promise<void>;
}

export interface KeyringContext {
  store: KeyringStore;
  /** The `forum` contract id (base58) holding `keyring` (and `vault`). */
  contractId: string;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/** A private unlocker held in memory while it is used; `wipe()` it afterwards. */
export interface UnlockKey {
  type: UnlockerType;
  pair: HpkeKeyPair;
  wipe(): void;
}

const mk = (type: UnlockerType, pair: HpkeKeyPair): UnlockKey => ({ type, pair, wipe: () => pair.privateKey.fill(0) });

/** The seed unlocker of a session that holds the seed (signed in with the phrase, or a passkey that keeps the seed). Else null. */
export function seedUnlockKey(s: Session): UnlockKey | null {
  if (!s.wallet || s.wallet.wiped) return null;
  const entropy = s.wallet.entropy();
  try {
    return mk(UnlockerType.SEED, seedUnlocker(entropy, s.network, identifierBytes(s.identityId)));
  } finally {
    wipe(entropy);
  }
}

/** Seed unlocker from a phrase typed again to re-open a locked keyring (the caller checks the phrase belongs to the identity). */
export function seedUnlockKeyFromEntropy(entropy: Uint8Array, network: Session['network'], identityId: string): UnlockKey {
  return mk(UnlockerType.SEED, seedUnlocker(entropy, network, identifierBytes(identityId)));
}

/** A passkey unlocker from the PRF output of an assertion made in this tab (the vault's PRF input). The caller wipes `prfOutput`. */
export function passkeyUnlockKey(prfOutput: Uint8Array): UnlockKey {
  return mk(UnlockerType.PASSKEY, recipientFromPrf(prfOutput));
}

export const signingKeyOf = (s: Session): SigningKey => ({ id: s.keyId, purpose: 0, securityLevel: s.securityLevel, type: KeyType.ECDSA_SECP256K1, privateKey: s.privateKey });

/** An opened keyring. Holds private voting keys until `close()`. */
export interface OpenedKeyring {
  ownerId: string;
  content: KeysContent;
  pending: PendingContent;
  keysDoc: KeyringDoc | null;
  pendingDoc: KeyringDoc | null;
  /** true: lists this session's seed unlocker; false: the session has the seed and it is NOT listed (planted?); null: cannot tell. */
  authenticated: boolean | null;
  /** Which unlocker opened it, and its public key (so the UI can mark "this passkey" / "this phrase"). */
  openedWith: UnlockerType;
  openedBy: Uint8Array | null;
  close(): void;
}

function opened(o: Omit<OpenedKeyring, 'close'>): OpenedKeyring {
  return { ...o, close: () => wipeKeysContent(o.content) };
}

export function emptyKeyring(ownerId: string, unlockers: Unlocker[]): OpenedKeyring {
  const keyringId = randomBytes(KEYRING_ID_LENGTH);
  return opened({
    ownerId,
    content: { keyringId, generation: 0, unlockers, keys: [], labels: [], idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES },
    pending: { keyringId: keyringId.slice(), votes: [] },
    keysDoc: null,
    pendingDoc: null,
    authenticated: true,
    openedWith: unlockers[0]?.type ?? UnlockerType.SEED,
    openedBy: unlockers[0]?.recipientKey ?? null,
  });
}

/**
 * Loads and opens the identity's keyring with `key`. Returns null when the identity has no keyring yet. Throws KeyringLockedError
 * when `key` is not one of its unlockers. `seedCheck` is the session's own seed unlocker (if any) for the authenticity check.
 */
export async function loadKeyring(ctx: KeyringContext, ownerId: string, key: UnlockKey, seedCheck: UnlockKey | null = key.type === UnlockerType.SEED ? key : null): Promise<OpenedKeyring | null> {
  const contractId = identifierBytes(ctx.contractId);
  const owner = identifierBytes(ownerId);
  const keysDoc = await ctx.store.get(ownerId, KeyringKind.KEYS);
  if (!keysDoc) return null;
  if (keysDoc.ownerId !== ownerId) throw new KeyringError('The keyring document belongs to another identity.');
  const pt = openKeyring({ contractId, ownerId: owner, kind: KeyringKind.KEYS, sealed: keysDoc.sealed, recipientPrivateKey: key.pair.privateKey });
  let content: KeysContent;
  try {
    content = decodeKeys(pt, keysDoc.sealed.bucket);
  } finally {
    pt.fill(0);
  }
  try {
    const authenticated = seedCheck ? content.unlockers.some((u) => u.type === UnlockerType.SEED && bytesEqual(u.recipientKey, seedCheck.pair.publicKey)) : null;
    let pending: PendingContent = { keyringId: content.keyringId.slice(), votes: [] };
    const pendingDoc = await ctx.store.get(ownerId, KeyringKind.PENDING);
    if (pendingDoc && pendingDoc.ownerId === ownerId) {
      // Opened with the seed when the session has it and the keyring lists it: a passkey's recipient key is public, so anyone holding a HIGH key could seal
      // a PENDING document to it. It must also carry this keyring's id, which only someone who could open KEYS knows.
      const pkey = authenticated && seedCheck ? seedCheck : key;
      try {
        const ppt = openKeyring({ contractId, ownerId: owner, kind: KeyringKind.PENDING, sealed: pendingDoc.sealed, recipientPrivateKey: pkey.pair.privateKey });
        try {
          const p = decodePending(ppt, pendingDoc.sealed.bucket);
          if (bytesEqual(p.keyringId, content.keyringId)) pending = p;
        } finally {
          ppt.fill(0);
        }
      } catch {
        // a pending document this key cannot open (written before an unlocker change, or planted) is ignored and overwritten
      }
    }
    return opened({ ownerId, content, pending, keysDoc, pendingDoc, authenticated, openedWith: key.type, openedBy: key.pair.publicKey.slice() });
  } catch (e) {
    wipeKeysContent(content);
    throw e;
  }
}

/** Adds an unlocker derived in this tab (seed or passkey ceremony). No-op if present. */
export function addUnlocker(k: OpenedKeyring, key: UnlockKey, now = Math.floor(Date.now() / 1000)): boolean {
  if (k.content.unlockers.some((u) => bytesEqual(u.recipientKey, key.pair.publicKey))) return false;
  if (k.content.unlockers.length >= MAX_UNLOCKERS) throw new KeyringError(`A keyring can have at most ${MAX_UNLOCKERS} ways to unlock it. Remove one first.`);
  k.content.unlockers.push({ type: key.type, recipientKey: key.pair.publicKey.slice(), addedAt: now });
  return true;
}

export function removeUnlocker(k: OpenedKeyring, recipientKey: Uint8Array): void {
  const left = k.content.unlockers.filter((u) => !bytesEqual(u.recipientKey, recipientKey));
  if (!left.length) throw new KeyringError('The keyring needs at least one way to unlock it.');
  k.content.unlockers = left;
}

/** Seals and writes the KEYS document (fresh key, every unlocker re-sealed). Signed with the session's HIGH/CRITICAL key. */
export async function saveKeys(ctx: KeyringContext, s: Session, k: OpenedKeyring): Promise<void> {
  assertLive(s);
  if (s.identityId !== k.ownerId) throw new KeyringError('This keyring belongs to another identity.');
  k.content.generation += 1;
  let encoded: ReturnType<typeof encodeKeys>;
  try {
    encoded = encodeKeys(k.content);
  } catch (e) {
    k.content.generation -= 1;
    throw e;
  }
  const { bucket, plaintext } = encoded;
  try {
    const sealed = sealKeyring({ contractId: identifierBytes(ctx.contractId), ownerId: identifierBytes(k.ownerId), kind: KeyringKind.KEYS, bucket, plaintext, recipients: k.content.unlockers.map((u) => u.recipientKey) });
    const r = await ctx.store.put({ ownerId: k.ownerId, key: signingKeyOf(s), kind: KeyringKind.KEYS, sealed, existing: k.keysDoc });
    k.keysDoc = { id: r.id, ownerId: k.ownerId, revision: r.revision, kind: KeyringKind.KEYS, sealed };
  } catch (e) {
    k.content.generation -= 1;
    throw e;
  } finally {
    plaintext.fill(0);
  }
}

/** Seals and writes the PENDING document to the same unlockers. */
export async function savePending(ctx: KeyringContext, s: Session, k: OpenedKeyring): Promise<void> {
  assertLive(s);
  if (s.identityId !== k.ownerId) throw new KeyringError('This keyring belongs to another identity.');
  k.pending.keyringId = k.content.keyringId.slice();
  const { bucket, plaintext } = encodePending(k.pending);
  const sealed = sealKeyring({ contractId: identifierBytes(ctx.contractId), ownerId: identifierBytes(k.ownerId), kind: KeyringKind.PENDING, bucket, plaintext, recipients: k.content.unlockers.map((u) => u.recipientKey) });
  const r = await ctx.store.put({ ownerId: k.ownerId, key: signingKeyOf(s), kind: KeyringKind.PENDING, sealed, existing: k.pendingDoc });
  k.pendingDoc = { id: r.id, ownerId: k.ownerId, revision: r.revision, kind: KeyringKind.PENDING, sealed };
}

/** Deletes both documents (the keys stay in memory until `close()`). */
export async function deleteKeyring(ctx: KeyringContext, s: Session, k: OpenedKeyring): Promise<void> {
  assertLive(s);
  for (const doc of [k.pendingDoc, k.keysDoc]) if (doc) await ctx.store.remove({ ownerId: k.ownerId, key: signingKeyOf(s), doc });
  k.keysDoc = null;
  k.pendingDoc = null;
}
