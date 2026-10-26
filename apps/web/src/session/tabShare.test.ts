// session/tabShare.ts: tabs of one browser share the sign-in over a BroadcastChannel, here a fake one that clones like the real one.
import {
  hash160, KeyPurpose, makeSession, publicKeyOf, randomBytes, SecurityLevel, SeedWallet, toBase58, type IdentityKeyInfo, type PlatformPort, type Session,
} from '@govhub/auth';
import { afterEach, describe, expect, it } from 'vitest';
import { createTabShare, type TabChannel, type TabShare } from './tabShare.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PROFILE = 'testnet:FORUM';
const tick = () => new Promise((r) => setTimeout(r, 0));
const zero = (b: Uint8Array) => b.every((x) => x === 0);
const typed = (type: string) => (m: unknown) => (m as { type: string }).type === type;
/** The secret bytes of every delivered session message. */
const deliveredSecrets = (b: { delivered: unknown[] }) =>
  b.delivered.filter(typed('session')).flatMap((m) => {
    const { entropy, privateKey } = (m as { material: { entropy?: Uint8Array; privateKey?: Uint8Array } }).material;
    return [entropy ?? privateKey!];
  });

/** A broadcast bus: every message is structured-cloned to every other open end, asynchronously (as BroadcastChannel does). */
function bus() {
  const ends = new Set<{ deliver(d: unknown): void }>();
  const sent: unknown[] = [];
  /** Every copy handed to a tab, to check it was wiped. */
  const delivered: unknown[] = [];
  return {
    sent,
    delivered,
    open(onMessage: (d: unknown) => void): TabChannel {
      const end = { deliver: onMessage };
      ends.add(end);
      return {
        postMessage(m) {
          sent.push(m);
          for (const e of ends) if (e !== end) {
            const copy = structuredClone(m);
            delivered.push(copy);
            setTimeout(() => ends.has(e) && e.deliver(copy), 0);
          }
        },
        close: () => void ends.delete(end),
      };
    },
    /** A message from another same-origin script, not from a tab of ours. */
    inject(m: unknown) {
      for (const e of ends) e.deliver(m);
    },
  };
}

/** Just enough Platform for signInWithSeed and signInWithKeyBytes. */
function platform(identities: Map<string, IdentityKeyInfo[]>): PlatformPort {
  return {
    network: 'testnet',
    identityKeys: async (id: string) => identities.get(id) ?? null,
    identityByUniqueKeyHash: async (h: Uint8Array) => {
      for (const [id, keys] of identities) if (keys.some((k) => hash160(k.data).every((b, i) => b === h[i]))) return id;
      return null;
    },
    identitiesByNonUniqueKeyHash: async () => [],
  } as unknown as PlatformPort;
}
const keyInfo = (id: number, securityLevel: number, priv: Uint8Array): IdentityKeyInfo =>
  ({ id, purpose: KeyPurpose.AUTHENTICATION, securityLevel, type: 0, data: publicKeyOf(priv), disabled: false, bound: false }) as IdentityKeyInfo;

const SEED_ID = toBase58(randomBytes(32));
const UNLOCKED = { locked: false, gen: 1, identityId: SEED_ID };
const KEY_ID = toBase58(randomBytes(32));
const pasted = randomBytes(32);
function chain(): Map<string, IdentityKeyInfo[]> {
  const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
  const ids = new Map<string, IdentityKeyInfo[]>([
    [SEED_ID, [keyInfo(0, SecurityLevel.MASTER, w.identityKey(0, 0).privateKey), keyInfo(2, SecurityLevel.HIGH, w.identityKey(0, 2).privateKey)]],
    [KEY_ID, [keyInfo(1, SecurityLevel.CRITICAL, pasted)]],
  ]);
  w.wipe();
  return ids;
}
const seedSession = (source: 'seed' | 'passkey' = 'seed', credentialId?: Uint8Array): Session => {
  const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
  return makeSession({ network: 'testnet', identityId: SEED_ID, identityIndex: 0, keyId: 2, securityLevel: SecurityLevel.HIGH, source, privateKey: wallet.identityKey(0, 2).privateKey, wallet, ...(credentialId && { credentialId }) });
};
const keySession = (): Session =>
  makeSession({ network: 'testnet', identityId: KEY_ID, identityIndex: null, keyId: 1, securityLevel: SecurityLevel.CRITICAL, source: 'key', privateKey: pasted.slice(), wallet: null });

const open: TabShare[] = [];
afterEach(() => open.splice(0).forEach((t) => t.close()));

/** One tab: its session slot, wired like AuthProvider wires it. */
function tab(
  b: ReturnType<typeof bus>,
  o: { profile?: string; live?: boolean; session?: Session; platform?: () => Promise<PlatformPort>; beforeAnswer?: () => void } = {},
) {
  const t = {
    session: o.session ?? (null as Session | null),
    live: o.live ?? true,
    restoring: [] as boolean[],
    drops: 0,
    adopted: [] as Session[],
    /** keyringLocked() calls: another tab's lock reached this one */
    locks: 0,
    share: null as unknown as TabShare,
  };
  t.share = createTabShare({
    profile: o.profile ?? PROFILE,
    live: () => t.live,
    current: () => t.session,
    platform: o.platform ?? (async () => platform(chain())),
    adopt: (s) => {
      t.session?.end();
      t.session = s;
      t.adopted.push(s);
    },
    drop: () => {
      t.drops++;
      t.session?.end();
      t.session = null;
    },
    restoring: (on) => t.restoring.push(on),
    keyringLocked: () => t.locks++,
    beforeAnswer: o.beforeAnswer,
    open: b.open,
    waitMs: 50,
  });
  open.push(t.share);
  return t;
}
/** Lets the messages land and the sign-in finish (PBKDF2 for a seed takes a moment). */
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

describe('tab sharing', () => {
  it('a new tab signs in with the session of an open tab (seed): same identity and key, its own copy', async () => {
    const b = bus();
    const a = tab(b, { session: seedSession() });
    const n = tab(b);
    n.share.request();
    await settle();
    expect(n.session?.identityId).toBe(SEED_ID);
    expect(n.session?.keyId).toBe(2);
    expect(n.session?.source).toBe('seed');
    expect(n.session?.wallet?.phrase()).toBe(PHRASE);
    expect(n.session?.privateKey).not.toBe(a.session?.privateKey);
    expect(n.session?.privateKey).toEqual(a.session?.privateKey);
    expect(n.restoring).toEqual([true, false]);
    expect(a.session?.ended).toBe(false);
  });

  it('a pasted key and a passkey session carry over too, with the passkey credential', async () => {
    const b = bus();
    tab(b, { session: keySession() });
    const n = tab(b);
    n.share.request();
    await settle();
    expect(n.session).toMatchObject({ identityId: KEY_ID, keyId: 1, source: 'key', securityLevel: SecurityLevel.CRITICAL });
    expect(n.session?.privateKey).toEqual(pasted);

    const b2 = bus();
    const cred = new Uint8Array(20).fill(7);
    tab(b2, { session: seedSession('passkey', cred) });
    const p = tab(b2);
    p.share.request();
    await settle();
    expect(p.session?.source).toBe('passkey');
    expect(p.session?.credentialId).toEqual(cred);
  });

  it('wipes every byte copy it sent or received once used', async () => {
    const b = bus();
    tab(b, { session: seedSession() });
    const n = tab(b);
    n.share.request();
    await settle();
    const reply = b.sent.find(typed('session')) as { material: { entropy: Uint8Array } };
    expect(zero(reply.material.entropy)).toBe(true); // the sender's copy, wiped right after posting
    expect(deliveredSecrets(b).every(zero)).toBe(true); // the receiver's copy, wiped once its wallet was made
    expect(n.session?.wallet?.phrase()).toBe(PHRASE); // the receiver's own wallet is intact
  });

  it('a failed sign-in with the material (Platform down, key no longer on the identity, seed not the identity\'s) wipes it', async () => {
    const down = bus();
    tab(down, { session: keySession() });
    const n1 = tab(down, { platform: async () => Promise.reject(new Error('offline')) });
    n1.share.request();
    await settle();

    const removed = bus();
    tab(removed, { session: keySession() });
    const n2 = tab(removed, { platform: async () => platform(new Map()) });
    n2.share.request();
    await settle();

    // a seed whose key 0 is not a key of the identity named (a tab cannot hand over someone else's identity with its own seed)
    const foreign = bus();
    tab(foreign, { session: seedSession() });
    const moved = chain();
    moved.set(SEED_ID, moved.get(SEED_ID)!.filter((k) => k.id !== 0));
    const n3 = tab(foreign, { platform: async () => platform(moved) });
    n3.share.request();
    await settle();

    for (const [b, n] of [[down, n1], [removed, n2], [foreign, n3]] as const) {
      expect(n.session).toBeNull();
      expect(n.restoring).toEqual([true, false]);
      expect(deliveredSecrets(b)).toHaveLength(1);
      expect(deliveredSecrets(b).every(zero)).toBe(true);
    }
  });

  it('ignores a session for another profile, and wipes it', async () => {
    const b = bus();
    tab(b, { session: seedSession(), profile: 'mainnet:FORUM' });
    const n = tab(b);
    n.share.request();
    await settle();
    expect(n.session).toBeNull();
    const entropy = new Uint8Array(16).fill(9);
    b.inject({ v: 2, type: 'session', keyring: UNLOCKED, profile: 'mainnet:FORUM', nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy } });
    await settle();
    expect(n.session).toBeNull();
    expect(zero(entropy)).toBe(true);
  });

  it('a sign-in in one tab is adopted by the others, replacing another identity', async () => {
    const b = bus();
    const a = tab(b);
    const other = tab(b, { session: keySession() });
    const old = other.session!;
    a.session = seedSession();
    a.share.announce(a.session);
    await settle();
    expect(other.session?.identityId).toBe(SEED_ID);
    expect(old.ended).toBe(true);
  });

  it('an explicit sign-out signs out every tab; a pagehide wipe tells nobody, and the restored page asks again', async () => {
    const b = bus();
    const a = tab(b, { session: seedSession() });
    const n = tab(b);
    n.share.request();
    await settle();
    expect(n.session).not.toBeNull();

    // pagehide in a: local wipe only
    a.share.suspend();
    a.session?.end();
    a.session = null;
    await settle();
    expect(n.session?.ended).toBe(false);
    expect(b.sent.some(typed('signout'))).toBe(false);

    // the bfcache restore asks again
    a.share.resume();
    await settle();
    expect((a.session as Session | null)?.identityId).toBe(SEED_ID);

    const kept = n.session!;
    n.share.signOut();
    await settle();
    expect(a.session).toBeNull();
    expect(a.drops).toBe(1);
    expect(kept.ended).toBe(false); // n signs itself out (AuthProvider), the message is for the others
  });

  it('a hidden page (pagehide, until pageshow) takes nothing in: no sign-in, no answer', async () => {
    const b = bus();
    const a = tab(b);
    a.share.suspend();
    const other = tab(b, { session: keySession() });
    other.share.announce(other.session!);
    await settle();
    expect(a.session).toBeNull();
    expect(deliveredSecrets(b).every(zero)).toBe(true);

    a.session = seedSession();
    const n = tab(b);
    other.session = null;
    n.share.request();
    await settle();
    expect(n.session).toBeNull();
    expect(b.sent.filter(typed('session'))).toHaveLength(1); // other's announce only
  });

  it('a sign-out in another tab does not touch a tab that is signed out (its sign-in sheet stays open)', async () => {
    const b = bus();
    const a = tab(b, { session: keySession() });
    const n = tab(b);
    a.share.signOut();
    await settle();
    expect(n.drops).toBe(0);
  });

  it('fixture-mode tabs neither send, answer nor adopt, but follow a sign-out', async () => {
    const b = bus();
    const live = tab(b, { session: seedSession() });
    const fx = tab(b, { live: false });
    fx.share.request();
    await settle();
    expect(fx.session).toBeNull();
    expect(b.sent).toHaveLength(0);

    live.share.announce(live.session!);
    await settle();
    expect(fx.session).toBeNull();

    // a fixture tab can hold a real session (the demo sheet allows it): it does not hand it out...
    const fx2 = tab(b, { live: false, session: keySession() });
    const n = tab(b);
    const liveSession = live.session;
    live.session = null;
    n.share.request();
    await settle();
    expect(n.session).toBeNull();
    fx2.share.announce(fx2.session!);
    fx2.share.signOut();
    await settle();
    expect(b.sent.filter((m) => !typed('request')(m))).toHaveLength(1); // only live's announce

    // ...but an explicit sign-out elsewhere ends it
    live.session = liveSession;
    live.share.signOut();
    await settle();
    expect(fx2.session).toBeNull();
    expect(fx2.drops).toBe(1);
  });

  it('ignores malformed messages and unsolicited replies, wiping their bytes', async () => {
    const b = bus();
    const n = tab(b);
    const msgs = [
      null, 'x', 42, { v: 3, type: 'signout', profile: PROFILE }, { v: 1, type: 'nope', profile: PROFILE },
      { v: 2, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(15) } },
      { v: 2, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce: null, material: { source: 'root', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(16).fill(1) } },
      { v: 2, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce: null, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: new Uint8Array(32).fill(1), entropy: new Uint8Array(16).fill(1) } },
      { v: 2, type: 'request', profile: PROFILE, nonce: 'short' },
      // a well-formed session without the keyring lock (version 1), or with a malformed one: never adopted, its bytes wiped
      { v: 2, type: 'session', profile: PROFILE, nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(16).fill(2) } },
      { v: 1, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(16).fill(3) } },
      ...[
        { locked: 'no', gen: 1 }, { locked: false, gen: -1, identityId: SEED_ID }, { locked: false, gen: 1 }, { locked: false, gen: 1, identityId: 'x' },
        { locked: true, gen: Infinity }, { locked: true }, null,
      ].map((keyring) => ({
        v: 2, type: 'session', keyring, profile: PROFILE, nonce: null, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: new Uint8Array(32).fill(4) },
      })),
      { v: 2, type: 'keyring', profile: PROFILE, keyring: { locked: false, gen: 'x' } },
      { v: 2, type: 'keyring', profile: PROFILE },
    ];
    for (const m of msgs) b.inject(m);
    await settle();
    expect(n.session).toBeNull();
    expect(n.share.keyringLocked(SEED_ID)).toBe(true);
    for (const m of msgs.slice(5) as Array<{ material?: Record<string, unknown> }>) for (const v of Object.values(m.material ?? {})) if (v instanceof Uint8Array) expect(zero(v)).toBe(true);

    // a reply to a nonce this tab never sent (or no longer waits for)
    const key = pasted.slice();
    b.inject({ v: 2, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce: 'ab'.repeat(16), material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: key } });
    await settle();
    expect(n.session).toBeNull();
    expect(zero(key)).toBe(true);

    n.share.request();
    await new Promise((r) => setTimeout(r, 80)); // past the wait
    const nonce = (b.sent.at(-1) as { nonce: string }).nonce;
    const late = pasted.slice();
    b.inject({ v: 2, type: 'session', keyring: UNLOCKED, profile: PROFILE, nonce, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: late } });
    await settle();
    expect(n.session).toBeNull();
    expect(zero(late)).toBe(true);
  });

  it('answers a request nonce once (a replayed request gets nothing)', async () => {
    const b = bus();
    tab(b, { session: keySession() });
    const nonce = 'cd'.repeat(16);
    b.inject({ v: 2, type: 'request', profile: PROFILE, nonce });
    b.inject({ v: 2, type: 'request', profile: PROFILE, nonce });
    await settle();
    expect(b.sent.filter(typed('session'))).toHaveLength(1);
  });

  for (const by of ['a sign-out in another tab', 'a sign-in in this tab', 'pagehide'] as const) {
    it(`${by} while a handed-over session is being signed in drops it, its key wiped`, async () => {
      const b = bus();
      const a = tab(b, { session: keySession() });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // a slow Platform: the sign-in with the material is still running when the change lands
      const n = tab(b, { platform: async () => (await gate, platform(chain())) });
      n.share.request();
      await settle();
      expect(n.restoring).toEqual([true]);
      if (by === 'a sign-out in another tab') a.share.signOut();
      else if (by === 'a sign-in in this tab') n.share.announce((n.session = seedSession()));
      else n.share.suspend();
      await settle();
      release();
      await settle();
      expect(n.adopted).toHaveLength(0);
      expect(n.restoring).toEqual([true, false]);
      // signInWithKeyBytes took the delivered key as the session's: zero means that session was ended
      expect(deliveredSecrets(b).filter((x) => x.length === 32).every(zero)).toBe(true);
    });
  }

  it('the same identity and key opened another way is not adopted (it would close the keyring for nothing)', async () => {
    const b = bus();
    const a = tab(b, { session: seedSession('passkey', new Uint8Array(16).fill(1)) });
    const n = tab(b, { session: seedSession() });
    a.share.announce(a.session!);
    await settle();
    expect(n.adopted).toHaveLength(0);
    expect(deliveredSecrets(b).every(zero)).toBe(true);
  });

  it('a tab already signed in with the same login does not sign in again', async () => {
    const b = bus();
    const a = tab(b, { session: keySession() });
    const n = tab(b, { session: keySession() });
    a.share.announce(a.session!);
    await settle();
    expect(n.adopted).toHaveLength(0);
    expect(n.restoring).toEqual([]);
  });
});

describe('the keyring lock across tabs (D-015)', () => {
  const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  /** A phrase sign-in of another identity (its own seed). */
  function otherSeedSession(): Session {
    const wallet = SeedWallet.fromPhrase(OTHER_PHRASE, 'testnet');
    return makeSession({ network: 'testnet', identityId: OTHER_ID, identityIndex: 0, keyId: 2, securityLevel: SecurityLevel.HIGH, source: 'seed', privateKey: wallet.identityKey(0, 2).privateKey, wallet });
  }
  const OTHER_ID = toBase58(randomBytes(32));
  /** A signed in with the phrase (announced), t2 took the session over: both unlocked. */
  async function signedInPair(b = bus()) {
    const a = tab(b, { session: seedSession() });
    a.share.announce(a.session!);
    const t2 = tab(b);
    t2.share.request();
    await settle();
    expect(t2.session?.identityId).toBe(SEED_ID);
    expect(a.share.keyringLocked(SEED_ID)).toBe(false);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(false);
    return { b, a, t2 };
  }
  /** A new tab (or a reload) of the session: asks, and takes the session over. */
  async function newTab(b: ReturnType<typeof bus>, profile?: string) {
    const n = tab(b, { profile });
    expect(n.share.keyringLocked(SEED_ID)).toBe(true); // locked until a tab says otherwise
    n.share.request();
    await settle();
    return n;
  }
  /** pagehide: the tab wipes its copy and takes nothing in. */
  function hide(t: ReturnType<typeof tab>) {
    t.share.suspend();
    t.session?.end();
    t.session = null;
  }
  const lastLock = (b: ReturnType<typeof bus>) => (b.sent.filter(typed('keyring')).at(-1) as { keyring: { gen: number } }).keyring;
  /** The time moves on (generations are timestamps). */
  const later = () => new Promise((r) => setTimeout(r, 3));

  it('a single tab: a fresh sign-in with the phrase unlocks that identity only; a pasted key or a passkey does not', () => {
    const b = bus();
    const a = tab(b);
    a.session = keySession();
    a.share.announce(a.session);
    expect(a.share.keyringLocked(KEY_ID)).toBe(true);
    // a passkey that keeps the seed: it could have been added to the vault while the keyring was locked
    a.session = seedSession('passkey', new Uint8Array(16).fill(5));
    a.share.announce(a.session);
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
    a.session = seedSession();
    a.share.announce(a.session);
    expect(a.share.keyringLocked(SEED_ID)).toBe(false);
    expect(a.share.keyringLocked(OTHER_ID)).toBe(true);
  });

  it('Lock now in one tab locks every other tab of the session, at once', async () => {
    const { a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.locks).toBe(1);
    expect(a.locks).toBe(0); // the locking tab locks itself (KeyringContext); its own message does not come back
    t2.share.lockKeyring(); // and the other way round
    await settle();
    expect(a.locks).toBe(1);
  });

  it('a new tab opened after a lock takes the session over locked', async () => {
    const { b, a } = await signedInPair();
    a.share.lockKeyring();
    const n = await newTab(b);
    expect(n.session?.identityId).toBe(SEED_ID); // still signed in...
    expect(n.share.keyringLocked(SEED_ID)).toBe(true); // ...but the keyring stays locked
  });

  it('a reload (or a page back from the bfcache) while another tab is open stays locked', async () => {
    const { b, a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    // reload of a: its page (and channel) goes, the new page asks t2
    a.share.close();
    a.session?.end();
    const reloaded = await newTab(b);
    expect(reloaded.session?.identityId).toBe(SEED_ID);
    expect(reloaded.share.keyringLocked(SEED_ID)).toBe(true);

    // bfcache: t2 hides (wipes its copy), the lock was before; restored, it asks again and stays locked
    hide(t2);
    t2.share.resume();
    await settle();
    expect((t2.session as Session | null)?.identityId).toBe(SEED_ID); // signed in again (TS narrowed it to null above)
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('a lock while a tab is hidden reaches it when it comes back from the bfcache', async () => {
    const { b, a, t2 } = await signedInPair();
    hide(t2);
    a.share.lockKeyring();
    await settle();
    expect(t2.share.keyringLocked(SEED_ID)).toBe(false); // heard nothing while hidden (and holds no session)
    t2.share.resume();
    await settle();
    expect((t2.session as Session | null)?.identityId).toBe(SEED_ID);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('a locked tab that switches profile and back, with another tab open, stays locked', async () => {
    const { b, a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    // a profile switch signs the tab out and opens a channel for the other profile; the tab of this profile does not answer it
    a.share.close();
    a.session?.end();
    const dev = await newTab(b, 'devnet:OTHER');
    expect(dev.session).toBeNull();
    dev.share.close();
    const back = await newTab(b);
    expect(back.session?.identityId).toBe(SEED_ID);
    expect(back.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('a late or replayed "unlocked" never undoes a lock; a lock is taken whatever its generation', async () => {
    const { b, a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    const { gen } = lastLock(b);
    const material = () => ({ source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: pasted.slice() });
    b.inject({ v: 2, type: 'keyring', profile: PROFILE, keyring: { locked: false, gen: gen - 1, identityId: SEED_ID } });
    b.inject({ v: 2, type: 'keyring', profile: PROFILE, keyring: { locked: false, gen, identityId: SEED_ID } }); // a tie: the lock stays
    b.inject({ v: 2, type: 'session', profile: PROFILE, nonce: null, keyring: { locked: false, gen: gen - 1, identityId: SEED_ID }, material: material() });
    await settle();
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
    expect((await newTab(b)).share.keyringLocked(SEED_ID)).toBe(true);

    // an old lock (lower generation than an unlock this tab heard) still locks
    await later();
    t2.share.unlockKeyring(SEED_ID);
    await settle();
    expect(a.share.keyringLocked(SEED_ID)).toBe(false);
    b.inject({ v: 2, type: 'keyring', profile: PROFILE, keyring: { locked: true, gen: 1 } });
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('the lock this tab already knows, repeated in another tab\'s answer, does not close what was opened since (memory-only keys)', async () => {
    const { b, a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    expect(t2.locks).toBe(1);
    await newTab(b); // a and t2 both answer "locked"
    expect(a.locks).toBe(0);
    expect(t2.locks).toBe(1);
    await later();
    a.share.lockKeyring(); // a new lock does
    await settle();
    expect(t2.locks).toBe(2);
  });

  it('the answer of a stale tab first, then the lock: the new tab ends up locked', async () => {
    const b = bus();
    const n = tab(b);
    n.share.request();
    const nonce = (b.sent.at(-1) as { nonce: string }).nonce;
    // a tab that had not heard the lock answers "unlocked", the lock lands while the new tab is still signing in
    b.inject({ v: 2, type: 'session', profile: PROFILE, nonce, keyring: { locked: false, gen: 5, identityId: KEY_ID }, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: pasted.slice() } });
    expect(n.share.keyringLocked(KEY_ID)).toBe(false);
    b.inject({ v: 2, type: 'keyring', profile: PROFILE, keyring: { locked: true, gen: 6 } });
    expect(n.share.keyringLocked(KEY_ID)).toBe(true);
    expect(n.locks).toBe(1); // the keyring here closes (or its open in flight is dropped)
    await settle();
    expect(n.session?.identityId).toBe(KEY_ID);
    expect(n.share.keyringLocked(KEY_ID)).toBe(true);
  });

  it('tabs that disagree (a lock and an unlock at once) all end up locked', async () => {
    const { b, a, t2 } = await signedInPair();
    t2.share.unlockKeyring(SEED_ID); // before either hears the other
    a.share.lockKeyring();
    await settle();
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.locks).toBe(1);
    expect((await newTab(b)).share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('a tab that slept through a sign-out and a new sign-in neither undoes a lock nor blocks an unlock (review repro 1)', async () => {
    const b = bus();
    // old tab: phrase sign-in, Lock now, phrase unlock, then signed out everywhere
    const old = tab(b, { session: seedSession() });
    old.share.announce(old.session!);
    await later();
    old.share.lockKeyring();
    await later();
    old.share.unlockKeyring(SEED_ID);
    old.share.signOut();
    old.session?.end();
    old.session = null;
    // a tab opened now hears nobody (signed-out tabs do not answer) and signs in with the phrase: old takes the sign-in over
    await later();
    const a = tab(b);
    a.share.request();
    await settle();
    a.session = seedSession();
    a.share.announce(a.session);
    await settle();
    expect((old.session as Session | null)?.identityId).toBe(SEED_ID);
    expect(old.share.keyringLocked(SEED_ID)).toBe(false); // the fresh sign-in unlocks the old tab too
    // Lock now in a: the old tab locks, and a new tab gets "locked" from both
    await later();
    a.share.lockKeyring();
    await settle();
    expect(old.locks).toBeGreaterThan(0);
    expect(old.share.keyringLocked(SEED_ID)).toBe(true);
    const c = await newTab(b);
    expect(c.share.keyringLocked(SEED_ID)).toBe(true);
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('a fresh phrase sign-in after a tab locked and signed out unlocks every tab: no stale lock outranks it (review finding 3)', async () => {
    const b = bus();
    const old = tab(b, { session: seedSession() });
    old.share.announce(old.session!);
    for (let i = 0; i < 3; i++) {
      await later();
      old.share.unlockKeyring(SEED_ID);
      old.share.lockKeyring();
    }
    old.share.signOut();
    old.session?.end();
    old.session = null;
    await later();
    const a = tab(b);
    a.share.request();
    await settle();
    a.session = seedSession();
    a.share.announce(a.session);
    await settle();
    expect((old.session as Session | null)?.identityId).toBe(SEED_ID);
    expect(old.share.keyringLocked(SEED_ID)).toBe(false);
    const c = await newTab(b);
    expect(c.share.keyringLocked(SEED_ID)).toBe(false);
    expect(a.share.keyringLocked(SEED_ID)).toBe(false);
  });

  it('a bfcache tab that comes back with a newer generation than a later lock still ends up locked', async () => {
    const { b, a, t2 } = await signedInPair();
    await later();
    t2.share.unlockKeyring(SEED_ID);
    await settle();
    hide(t2); // keeps its (newest) "unlocked"
    // the clock goes back (or a's state is otherwise older): a's lock has a lower generation than t2's unlock
    const real = Date.now;
    Date.now = () => 1;
    try {
      a.share.lockKeyring();
      await settle();
      t2.share.resume();
      await settle();
    } finally {
      Date.now = real;
    }
    expect((t2.session as Session | null)?.identityId).toBe(SEED_ID);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('another identity\'s sign-in unlocks only that identity: a tab still holding the locked session hands it over locked (review repro 2)', async () => {
    const ids = chain();
    const w = SeedWallet.fromPhrase(OTHER_PHRASE, 'testnet');
    ids.set(OTHER_ID, [keyInfo(0, SecurityLevel.MASTER, w.identityKey(0, 0).privateKey), keyInfo(2, SecurityLevel.HIGH, w.identityKey(0, 2).privateKey)]);
    w.wipe();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slow = false;
    const b = bus();
    const a = tab(b, { session: seedSession() });
    a.share.announce(a.session!);
    // t2 takes the victim's session over, then rebuilds slowly (Platform round trips) whatever comes next
    const t2 = tab(b, { platform: async () => (slow && (await gate), platform(ids)) });
    t2.share.request();
    await settle();
    expect(t2.session?.identityId).toBe(SEED_ID);
    a.share.lockKeyring();
    await settle();
    slow = true;
    // the attacker signs in to their own identity with their own phrase in a, then closes it
    await later();
    a.session?.end();
    a.session = otherSeedSession();
    a.share.announce(a.session);
    await settle();
    a.share.close();
    expect(t2.session?.identityId).toBe(SEED_ID); // still rebuilding the attacker's session
    // a tab back from the bfcache asks: only t2 answers, with the victim's session, locked for it
    const c = tab(b, { platform: async () => platform(ids) });
    c.share.request();
    await settle();
    expect(c.session?.identityId).toBe(SEED_ID);
    expect(c.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
    release();
    await settle();
    expect((t2.session as Session | null)?.identityId).toBe(OTHER_ID);
    expect(t2.share.keyringLocked(OTHER_ID)).toBe(false); // the attacker's own keyring is theirs to open
  });

  it('an idle lock propagates, and a new tab never beats one that is due (checked before answering)', async () => {
    const b = bus();
    let due = false;
    const a: ReturnType<typeof tab> = tab(b, { session: seedSession(), beforeAnswer: () => due && a.share.lockKeyring() });
    a.share.announce(a.session!);
    const t2 = await newTab(b);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(false);
    // a's idle timer is throttled in the background: the deadline passed but it has not fired yet when a new tab asks
    due = true;
    const n = await newTab(b);
    expect(n.session?.identityId).toBe(SEED_ID);
    expect(n.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true); // the idle lock locked the open tabs too
    expect(t2.locks).toBeGreaterThan(0);
  });

  it('the phrase or a passkey in one tab: tabs opened from then on may open it; the open tabs stay closed', async () => {
    const { b, a, t2 } = await signedInPair();
    a.share.lockKeyring();
    await settle();
    await later();
    t2.share.unlockKeyring(SEED_ID);
    await settle();
    expect(a.share.keyringLocked(SEED_ID)).toBe(false);
    expect(a.locks).toBe(0); // nothing reopens in a: KeyringContext opens only on a sign-in or an unlock in that tab
    expect((await newTab(b)).share.keyringLocked(SEED_ID)).toBe(false);
  });

  it('a pasted-key sign-in in another tab (the seed session\'s own key) does not unlock the locked seed session', async () => {
    const { b, a, t2 } = await signedInPair();
    const other = tab(b); // has heard everything (the newest generation)
    a.share.lockKeyring();
    await settle();
    // whoever holds the identity's key, but not the phrase: the same login, so a and t2 keep their seed sessions
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    other.session = makeSession({ network: 'testnet', identityId: SEED_ID, identityIndex: null, keyId: 2, securityLevel: SecurityLevel.HIGH, source: 'key', privateKey: w.identityKey(0, 2).privateKey, wallet: null });
    w.wipe();
    await later();
    other.share.announce(other.session);
    await settle();
    expect(a.session?.wallet).toBeTruthy();
    expect(t2.adopted).toHaveLength(1);
    expect(a.share.keyringLocked(SEED_ID)).toBe(true);
    expect(t2.share.keyringLocked(SEED_ID)).toBe(true);
    expect((await newTab(b)).share.keyringLocked(SEED_ID)).toBe(true);
  });

  it('fixture-mode tabs neither send nor take the lock', async () => {
    const b = bus();
    const live = tab(b, { session: seedSession() });
    live.share.announce(live.session!);
    const fx = tab(b, { live: false });
    fx.share.lockKeyring();
    await settle();
    expect(live.share.keyringLocked(SEED_ID)).toBe(false);
    live.share.lockKeyring();
    await settle();
    expect(fx.locks).toBe(0);
  });

  it('a sign-out is sent and taken as version 1 too, so the tabs of the older version follow it during a deploy', async () => {
    const b = bus();
    const a = tab(b, { session: keySession() });
    a.share.signOut();
    expect(b.sent.at(-1)).toEqual({ v: 1, type: 'signout', profile: PROFILE });
    const n = tab(b, { session: keySession() });
    b.inject({ v: 1, type: 'signout', profile: PROFILE });
    await settle();
    expect(n.session).toBeNull();
    expect(n.drops).toBe(1);
  });
});
