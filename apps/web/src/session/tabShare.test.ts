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
function tab(b: ReturnType<typeof bus>, o: { profile?: string; live?: boolean; session?: Session; platform?: () => Promise<PlatformPort> } = {}) {
  const t = {
    session: o.session ?? (null as Session | null),
    live: o.live ?? true,
    restoring: [] as boolean[],
    drops: 0,
    adopted: [] as Session[],
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
    b.inject({ v: 1, type: 'session', profile: 'mainnet:FORUM', nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy } });
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
      null, 'x', 42, { v: 2, type: 'signout', profile: PROFILE }, { v: 1, type: 'nope', profile: PROFILE },
      { v: 1, type: 'session', profile: PROFILE, nonce: null, material: { source: 'seed', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(15) } },
      { v: 1, type: 'session', profile: PROFILE, nonce: null, material: { source: 'root', identityId: SEED_ID, keyId: 2, identityIndex: 0, entropy: new Uint8Array(16).fill(1) } },
      { v: 1, type: 'session', profile: PROFILE, nonce: null, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: new Uint8Array(32).fill(1), entropy: new Uint8Array(16).fill(1) } },
      { v: 1, type: 'request', profile: PROFILE, nonce: 'short' },
    ];
    for (const m of msgs) b.inject(m);
    await settle();
    expect(n.session).toBeNull();
    for (const m of msgs.slice(5) as Array<{ material?: Record<string, unknown> }>) for (const v of Object.values(m.material ?? {})) if (v instanceof Uint8Array) expect(zero(v)).toBe(true);

    // a reply to a nonce this tab never sent (or no longer waits for)
    const key = pasted.slice();
    b.inject({ v: 1, type: 'session', profile: PROFILE, nonce: 'ab'.repeat(16), material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: key } });
    await settle();
    expect(n.session).toBeNull();
    expect(zero(key)).toBe(true);

    n.share.request();
    await new Promise((r) => setTimeout(r, 80)); // past the wait
    const nonce = (b.sent.at(-1) as { nonce: string }).nonce;
    const late = pasted.slice();
    b.inject({ v: 1, type: 'session', profile: PROFILE, nonce, material: { source: 'key', identityId: KEY_ID, keyId: 1, identityIndex: null, privateKey: late } });
    await settle();
    expect(n.session).toBeNull();
    expect(zero(late)).toBe(true);
  });

  it('answers a request nonce once (a replayed request gets nothing)', async () => {
    const b = bus();
    tab(b, { session: keySession() });
    const nonce = 'cd'.repeat(16);
    b.inject({ v: 1, type: 'request', profile: PROFILE, nonce });
    b.inject({ v: 1, type: 'request', profile: PROFILE, nonce });
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
