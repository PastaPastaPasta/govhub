// One sign-in for all of this browser's open govhub tabs. The tabs hand the session to each other in memory over a BroadcastChannel
// (same origin only); the secrets are never written anywhere (no localStorage, sessionStorage, IndexedDB or cookies), so a browser
// restart, or closing the last tab, signs out.
//  - A new tab (or one restored from the back/forward cache) asks, with a fresh nonce, for the session of its profile (Platform
//    network + forum contract); a signed-in tab answers with the minimal material, and the asking tab signs in with it through the
//    normal sign-in path (a seed: discovery's key-0 lookup, then signInWithSeed; a key: signInWithKeyBytes), checked on chain again.
//  - A sign-in in any tab is adopted by the other tabs of that profile (also replacing another identity: there is one login), and an
//    explicit sign-out signs every tab out. A local wipe (`pagehide`, a profile or data-mode switch) stays in its tab, and a hidden
//    page (`pagehide` until a back/forward-cache `pageshow`) takes nothing in.
//  - Every tab of the origin hears every message: sharing is for an origin govhub has to itself (AuthProvider turns it off when
//    served from a sub-path, such as a shared GitHub Pages origin).
//  - The masternode keyring (voting/KeyringContext.tsx) and passkey PRF outputs stay in their tab; only the keyring's LOCK is shared
//    (D-015): a lock in any tab (button or idle) locks every tab, and a tab that takes the session over opens the keyring with the
//    seed only while the session says unlocked for that identity. Fail closed: a new tab starts locked, a lock heard from any tab is
//    always taken, and an "unlocked" only when it is newer than everything this tab has heard. Generations are timestamps (the tabs
//    of a browser share its clock), so a tab that slept through sign-outs, sign-ins or a bfcache stay compares like the others.
// Received bytes are wiped once used (or ignored); none of the material is ever logged.
import { hash160, SeedWallet, signInWithKeyBytes, signInWithSeed, SignInError, wipe, type KeyMatch, type PlatformPort, type Session, type SessionSource } from '@govhub/auth';

const CHANNEL_NAME = 'govhub.session';
/** How long a new tab waits for an answer; it shows signed out meanwhile (first render is never held up). */
const REPLY_WAIT_MS = 300;

// 2: the keyring lock (a tab of version 1 would open a locked keyring: the versions do not talk, except that a sign-out, which only
// ever wipes, is sent and taken as version 1 so the tabs of both versions follow it while a deploy rolls out)
const V = 2;
const SIGNOUT_V = 1;
const SOURCES: readonly SessionSource[] = ['seed', 'key', 'passkey'];
const NONCE = /^[0-9a-f]{32}$/;
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEEN_LIMIT = 64;

/** What a tab needs to sign in again as the same identity with the same key: a seed's entropy, else the key itself. */
interface Material {
  source: SessionSource;
  identityId: string;
  keyId: number;
  identityIndex: number | null;
  /** BIP39 entropy (seed sessions, also passkey-opened seeds). */
  entropy?: Uint8Array;
  /** The sign-in key (key sessions, also passkey-opened keys). */
  privateKey?: Uint8Array;
  credentialId?: Uint8Array;
}

/**
 * The masternode keyring's lock, shared by the tabs. Locked: for every identity. Unlocked: for `identityId` only (the one whose phrase
 * or passkey unlocked it, or that signed in with its phrase). `gen`: when it was set (ms; at least one more than the last one heard).
 */
type KeyringLockState = { locked: true; gen: number } | { locked: false; gen: number; identityId: string };

type Message =
  | { type: 'request'; profile: string; nonce: string }
  /** nonce: the request answered; null: a sign-in announced by the tab that made it. */
  | { type: 'session'; profile: string; nonce: string | null; material: Material; keyring: KeyringLockState }
  | { type: 'signout'; profile: string }
  | { type: 'keyring'; profile: string; keyring: KeyringLockState };

/** The part of a BroadcastChannel this needs. */
export interface TabChannel {
  postMessage(message: unknown): void;
  close(): void;
}

function openBroadcastChannel(onMessage: (data: unknown) => void): TabChannel {
  const c = new BroadcastChannel(CHANNEL_NAME);
  c.onmessage = (e) => onMessage(e.data);
  return c;
}

export interface TabShareOptions {
  /** `${platformNetwork}:${forumContractId}`: only tabs on the same profile share. */
  profile: string;
  /** False in fixture mode: nothing is sent, answered or adopted (a sign-out is still followed). Read on every message. */
  live(): boolean;
  /** This tab's real session, if any. */
  current(): Session | null;
  platform(): Promise<PlatformPort>;
  /** Signs this tab in with a session rebuilt from another tab's material (no announcement). */
  adopt(s: Session): void;
  /** Signs this tab out (another tab signed out explicitly); called only while this tab has a session. */
  drop(): void;
  /** True while a received session is being rebuilt (a short "restoring" state). */
  restoring?(on: boolean): void;
  /** Another tab locked the keyring (also: a session taken over says locked): close it here and wipe its keys, now. */
  keyringLocked?(): void;
  /** Runs before this tab answers a request with its session: an idle lock that is due locks first (a new tab never beats it). */
  beforeAnswer?(): void;
  open?: (onMessage: (data: unknown) => void) => TabChannel;
  waitMs?: number;
}

export interface TabShare {
  /** Asks the other tabs for their session (a new tab, or one restored from the back/forward cache), unless signed in already. */
  request(): void;
  /** This tab signed in: the other tabs adopt it. */
  announce(s: Session): void;
  /** Explicit sign-out in this tab: every tab signs out. */
  signOut(): void;
  /** The keyring is locked for `identityId`: its saved copy may not be opened with the session's seed (only the phrase or a passkey). */
  keyringLocked(identityId: string): boolean;
  /** This tab locked the keyring (button or idle): every tab locks. */
  lockKeyring(): void;
  /**
   * The phrase or a passkey opened `identityId`'s keyring in this tab: a tab that takes that session over from now on may open it with
   * the seed. The other open tabs stay locked until they are unlocked themselves.
   */
  unlockKeyring(identityId: string): void;
  /** `pagehide`: forgets a pending request or restore and takes nothing in until resume(); tells nobody. */
  suspend(): void;
  /** `pageshow` from the back/forward cache: takes messages again and asks the open tabs for the session. */
  resume(): void;
  close(): void;
}

export function createTabShare(o: TabShareOptions): TabShare {
  const channel = (o.open ?? openBroadcastChannel)(receive);
  let closed = false;
  let hidden = false;
  let pending: { nonce: string; timer: ReturnType<typeof setTimeout> } | null = null;
  // bumped by every sign-in, sign-out or cancel: a restore that finishes under an older generation is dropped (its key wiped)
  let gen = 0;
  const seen = new Set<string>();
  let lock: KeyringLockState = { locked: true, gen: 0 }; // before it hears from the others (and before any sign-in here): locked

  const post = (m: Message) => channel.postMessage({ v: V, ...m }); // cloned synchronously: the caller may wipe right after
  const clearPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };
  const supersede = () => {
    gen++;
    clearPending();
    o.restoring?.(false);
  };
  const live = () => !closed && o.live();
  const liveSession = () => {
    const s = o.current();
    return s && !s.ended ? s : null;
  };
  /** A change made here: later than everything heard. */
  const setLock = (identityId: string | null) => {
    const at = Math.max(lock.gen + 1, Date.now());
    lock = identityId === null ? { locked: true, gen: at } : { locked: false, gen: at, identityId };
  };
  const shareLock = (identityId: string | null) => {
    setLock(identityId);
    if (live()) post({ type: 'keyring', profile: o.profile, keyring: lock });
  };
  /**
   * Another tab's state: a lock is always taken, and closes the keyring here unless it is the lock this tab already knows (memory-only
   * keys added since stay); an unlock is taken only if newer than this tab's state.
   */
  function hear(k: KeyringLockState) {
    if (k.locked) {
      const news = !lock.locked || k.gen > lock.gen;
      lock = { locked: true, gen: Math.max(lock.gen, k.gen) };
      if (news) o.keyringLocked?.();
    } else if (k.gen > lock.gen) lock = k;
  }

  function receive(data: unknown) {
    const m = parse(data);
    if (!m || closed || hidden || m.profile !== o.profile) return wipeLoose(data);
    if (m.type === 'signout') {
      supersede();
      if (liveSession()) o.drop();
      return;
    }
    if (!o.live()) return wipeLoose(data); // fixture mode opens only the demo keyring: nothing to lock
    if (m.type === 'keyring') return hear(m.keyring);
    if (m.type === 'request') {
      if (seen.has(m.nonce)) return;
      seen.add(m.nonce);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      o.beforeAnswer?.();
      const s = liveSession();
      if (s) send(s, m.nonce);
      return;
    }
    // before the session is taken over: the keyring of the session adopted below opens only if the newest state says unlocked
    hear(m.keyring);
    if (m.nonce === null || m.nonce === pending?.nonce) void restore(m.material);
    else wipeMaterial(m.material);
  }

  function send(s: Session, nonce: string | null) {
    const material = materialOf(s);
    if (!material) return;
    try {
      post({ type: 'session', profile: o.profile, nonce, material, keyring: lock });
    } finally {
      wipeMaterial(material);
    }
  }

  async function restore(m: Material) {
    clearPending();
    const cur = liveSession();
    // the same login already (whatever it was opened with: replacing it would close this tab's keyring for nothing)
    if (cur && cur.identityId === m.identityId && cur.keyId === m.keyId) return wipeMaterial(m);
    const g = ++gen;
    o.restoring?.(true);
    let s: Session;
    try {
      s = await rebuild(m, await o.platform());
    } catch {
      wipeMaterial(m); // not logged: nothing about the material may leak
      if (g === gen) o.restoring?.(false);
      return;
    }
    if (g !== gen || !live()) return s.end();
    o.adopt(s);
    o.restoring?.(false);
  }

  function request() {
    if (!live() || hidden || liveSession()) return;
    clearPending();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    pending = { nonce, timer: setTimeout(() => pending?.nonce === nonce && clearPending(), o.waitMs ?? REPLY_WAIT_MS) };
    post({ type: 'request', profile: o.profile, nonce });
  }

  return {
    request,
    announce(s) {
      supersede();
      // a sign-in here with the phrase opens its keyring, and so may the tabs that adopt it. A pasted key proves nothing about the
      // phrase, nor does a passkey (one can be added to the vault while the keyring is locked): those change nothing here (a passkey
      // that opens the keyring unlocks it through unlockKeyring)
      if (s.source === 'seed' && s.wallet) setLock(s.identityId);
      if (live()) send(s, null);
    },
    signOut() {
      supersede();
      if (live()) channel.postMessage({ v: SIGNOUT_V, type: 'signout', profile: o.profile });
    },
    keyringLocked: (identityId) => lock.locked || lock.identityId !== identityId,
    lockKeyring: () => shareLock(null),
    unlockKeyring: (identityId) => shareLock(identityId),
    suspend() {
      supersede();
      hidden = true;
    },
    resume() {
      supersede();
      hidden = false;
      request();
    },
    close() {
      supersede();
      closed = true;
      channel.close();
    },
  };
}

function materialOf(s: Session): Material | null {
  if (s.ended) return null;
  const base = { source: s.source, identityId: s.identityId, keyId: s.keyId, ...(s.credentialId && { credentialId: s.credentialId.slice() }) };
  if (s.wallet && s.identityIndex !== null) return s.wallet.wiped ? null : { ...base, identityIndex: s.identityIndex, entropy: s.wallet.entropy() };
  return { ...base, identityIndex: null, privateKey: s.privateKey.slice() };
}

/** Signs in with the material through the normal sign-in functions; they take ownership of the bytes (wiped on failure by the caller). */
async function rebuild(m: Material, port: PlatformPort): Promise<Session> {
  if (m.entropy) {
    let wallet: SeedWallet;
    try {
      wallet = SeedWallet.fromEntropy(m.entropy, port.network);
    } finally {
      wipe(m.entropy); // the wallet keeps its own copy
    }
    try {
      // as discovery finds it for a phrase sign-in: the identity whose key is this seed's key 0 at the index
      const k0 = wallet.identityKey(m.identityIndex!, 0);
      wipe(k0.privateKey);
      if ((await port.identityByUniqueKeyHash(hash160(k0.publicKey))) !== m.identityId) throw new SignInError('This recovery phrase does not hold that identity.');
      return await signInWithSeed(wallet, { identityIndex: m.identityIndex!, identityId: m.identityId }, port, m.source, m.credentialId);
    } catch (e) {
      wallet.wipe();
      throw e;
    }
  }
  const pick = (ms: KeyMatch[]) => {
    const hit = ms.find((x) => x.identityId === m.identityId && x.keyId === m.keyId);
    if (!hit) throw new SignInError('This key no longer signs in to that identity.');
    return hit;
  };
  return signInWithKeyBytes(m.privateKey!, port, pick, m.source, m.credentialId);
}

const isBytes = (x: unknown, ...lengths: number[]): x is Uint8Array => x instanceof Uint8Array && lengths.includes(x.length);
const isIndex = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < 0x80000000;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

function parseMaterial(x: unknown): Material | null {
  if (!isObject(x)) return null;
  const { source, identityId, keyId, identityIndex, entropy, privateKey, credentialId } = x;
  if (!SOURCES.includes(source as SessionSource) || typeof identityId !== 'string' || !BASE58_ID.test(identityId) || !isIndex(keyId)) return null;
  if (credentialId !== undefined && !(credentialId instanceof Uint8Array && credentialId.length >= 16 && credentialId.length <= 255)) return null;
  const cred = credentialId === undefined ? {} : { credentialId };
  const base = { source: source as SessionSource, identityId, keyId };
  // exactly one secret: a seed (with its identity index) or a key
  if (isBytes(entropy, 16, 32) && privateKey === undefined && isIndex(identityIndex)) return { ...base, ...cred, identityIndex, entropy };
  if (isBytes(privateKey, 32) && entropy === undefined && identityIndex === null) return { ...base, ...cred, identityIndex: null, privateKey };
  return null;
}

function parseLock(x: unknown): KeyringLockState | null {
  if (!isObject(x) || typeof x.gen !== 'number' || !Number.isFinite(x.gen) || x.gen < 0) return null;
  if (x.locked === true) return { locked: true, gen: x.gen };
  return x.locked === false && typeof x.identityId === 'string' && BASE58_ID.test(x.identityId) ? { locked: false, gen: x.gen, identityId: x.identityId } : null;
}

function parse(data: unknown): Message | null {
  if (!isObject(data) || typeof data.profile !== 'string') return null;
  const { type, profile, nonce } = data;
  if (type === 'signout' && data.v === SIGNOUT_V) return { type, profile };
  if (data.v !== V) return null;
  if (type === 'request') return typeof nonce === 'string' && NONCE.test(nonce) ? { type, profile, nonce } : null;
  const keyring = parseLock(data.keyring);
  if (!keyring) return null;
  if (type === 'keyring') return { type, profile, keyring };
  if (type !== 'session' || !(nonce === null || (typeof nonce === 'string' && NONCE.test(nonce)))) return null;
  const material = parseMaterial(data.material);
  return material && { type, profile, nonce, material, keyring };
}

function wipeMaterial(m: Material) {
  wipe(m.entropy, m.privateKey, m.credentialId);
}

/** Wipes whatever bytes an ignored or malformed message carried. */
function wipeLoose(data: unknown) {
  if (!isObject(data)) return;
  for (const v of [...Object.values(data), ...(isObject(data.material) ? Object.values(data.material) : [])]) if (v instanceof Uint8Array) wipe(v);
}
