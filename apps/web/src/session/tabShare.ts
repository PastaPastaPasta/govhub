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
//  - Only the login is shared: the masternode keyring (voting/KeyringContext.tsx) and passkey PRF outputs stay in their tab.
// Received bytes are wiped once used (or ignored); none of the material is ever logged.
import { hash160, SeedWallet, signInWithKeyBytes, signInWithSeed, SignInError, wipe, type KeyMatch, type PlatformPort, type Session, type SessionSource } from '@govhub/auth';

const CHANNEL_NAME = 'govhub.session';
/** How long a new tab waits for an answer; it shows signed out meanwhile (first render is never held up). */
const REPLY_WAIT_MS = 300;

const V = 1;
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

type Message =
  | { type: 'request'; profile: string; nonce: string }
  /** nonce: the request answered; null: a sign-in announced by the tab that made it. */
  | { type: 'session'; profile: string; nonce: string | null; material: Material }
  | { type: 'signout'; profile: string };

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

  function receive(data: unknown) {
    const m = parse(data);
    if (!m || closed || hidden || m.profile !== o.profile) return wipeLoose(data);
    if (m.type === 'signout') {
      supersede();
      if (liveSession()) o.drop();
      return;
    }
    if (!o.live()) return wipeLoose(data);
    if (m.type === 'request') {
      if (seen.has(m.nonce)) return;
      seen.add(m.nonce);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      const s = liveSession();
      if (s) send(s, m.nonce);
    } else if (m.nonce === null || m.nonce === pending?.nonce) void restore(m.material);
    else wipeMaterial(m.material);
  }

  function send(s: Session, nonce: string | null) {
    const material = materialOf(s);
    if (!material) return;
    try {
      post({ type: 'session', profile: o.profile, nonce, material });
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
      if (live()) send(s, null);
    },
    signOut() {
      supersede();
      if (live()) post({ type: 'signout', profile: o.profile });
    },
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

function parse(data: unknown): Message | null {
  if (!isObject(data) || data.v !== V || typeof data.profile !== 'string') return null;
  const { type, profile, nonce } = data;
  if (type === 'request') return typeof nonce === 'string' && NONCE.test(nonce) ? { type, profile, nonce } : null;
  if (type === 'signout') return { type, profile };
  if (type !== 'session' || !(nonce === null || (typeof nonce === 'string' && NONCE.test(nonce)))) return null;
  const material = parseMaterial(data.material);
  return material && { type, profile, nonce, material };
}

function wipeMaterial(m: Material) {
  wipe(m.entropy, m.privateKey, m.credentialId);
}

/** Wipes whatever bytes an ignored or malformed message carried. */
function wipeLoose(data: unknown) {
  if (!isObject(data)) return;
  for (const v of [...Object.values(data), ...(isObject(data.material) ? Object.values(data.material) : [])]) if (v instanceof Uint8Array) wipe(v);
}
