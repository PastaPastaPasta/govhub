import { describe, expect, it } from 'vitest';
import forumSchemas from '@govhub/contracts-v1/forum.json';
import { lintQuery, type ContractSchemas } from '@govhub/contracts-v1/queryLint';
import { bytesToHex, randomBytes, toBase58, toBase64 } from '../src/bytes.ts';
import { SeedWallet } from '../src/seed.ts';
import { makeSession, type Session } from '../src/signin.ts';
import { recipientFromPrf } from '../src/vault/bundle.ts';
import {
  CHUNK_LENGTH,
  decodeKeys,
  decodePending,
  encodeKeys,
  encodePending,
  KEYS_CAPS,
  KeyringFormatError,
  KeyringKind,
  MAX_LABEL_BYTES,
  normalizeLabel,
  PENDING_CAPS,
  plaintextLength,
  UnlockerType,
  type KeysContent,
  type PendingContent,
  type PendingVote,
} from '../src/keyring/format.ts';
import { KeyringLockedError, openKeyring, sealKeyring, seedUnlocker, SLOT_COUNT, SLOT_LENGTH, WRAPS_LENGTH } from '../src/keyring/seal.ts';
import { addUnlocker, emptyKeyring, loadKeyring, passkeyUnlockKey, removeUnlocker, savePending, saveKeys, seedUnlockKey, type KeyringDoc, type KeyringStore } from '../src/keyring/keyring.ts';
import { keyringDocFromJson, keyringQuery } from '../src/keyring/evo-store.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const contract = randomBytes(32);
const contractId = toBase58(contract);
const owner = randomBytes(32);
const ownerId = toBase58(owner);
const longLabel = 'é'.repeat(16); // 32 UTF-8 bytes
const key = (i: number) => {
  const k = new Uint8Array(32);
  k[31] = (i % 250) + 1;
  k[30] = Math.floor(i / 250) + 1;
  return k;
};
const unlocker = (t: UnlockerType = UnlockerType.PASSKEY) => ({ type: t, recipientKey: randomBytes(32), addedAt: 1_800_000_000 });
const RID = randomBytes(16);
const content = (nKeys: number, nLabels: number, nUnlockers = 8): KeysContent => ({
  keyringId: RID,
  generation: 7,
  unlockers: Array.from({ length: nUnlockers }, () => unlocker()),
  keys: Array.from({ length: nKeys }, (_, i) => ({ privateKey: key(i), compressed: i % 2 === 0, label: longLabel })),
  labels: Array.from({ length: nLabels }, () => ({ proTxHash: bytesToHex(randomBytes(32)), label: longLabel })),
  idleLockMinutes: 15,
});
const vote = (i: number, relays = ['https://relay-a.example', 'https://relay-b.example']): PendingVote => ({
  collateralTxid: bytesToHex(randomBytes(32)),
  collateralIndex: i,
  govHash: bytesToHex(randomBytes(32)),
  outcome: 1 + (i % 3),
  time: 1_800_000_000 + i,
  sig: randomBytes(65),
  releaseAt: 1_800_000_000 + i,
  refs: relays.map((relay) => ({ relay, id: bytesToHex(randomBytes(16)) })),
});

describe('keyring format', () => {
  it('fits the documented caps with maximum-length labels', () => {
    expect(new TextEncoder().encode(longLabel).length).toBe(MAX_LABEL_BYTES);
    for (const b of [1, 2] as const) {
      const c = content(KEYS_CAPS[b].keys, KEYS_CAPS[b].labels);
      const { bucket, plaintext } = encodeKeys(c);
      expect(bucket).toBe(b);
      expect(plaintext.length).toBe(plaintextLength(b));
      const back = decodeKeys(plaintext, b);
      expect(back.keys.map((k) => bytesToHex(k.privateKey))).toEqual(c.keys.map((k) => bytesToHex(k.privateKey)));
      expect(back.keys.map((k) => k.compressed)).toEqual(c.keys.map((k) => k.compressed));
      expect(back.labels).toEqual(c.labels);
      expect(back.unlockers).toEqual(c.unlockers);
    }
    for (const b of [1, 2] as const) {
      const p: PendingContent = { keyringId: RID, votes: Array.from({ length: PENDING_CAPS[b].votes }, (_, i) => vote(i, ['https://r1.example/' + 'x'.repeat(100), 'https://r2.example/' + 'y'.repeat(100)])) };
      const { bucket, plaintext } = encodePending(p);
      expect(bucket).toBe(b);
      expect(decodePending(plaintext, b)).toEqual(p);
    }
  });
  it('picks the bucket from counts only and refuses beyond bucket 2', () => {
    expect(encodeKeys(content(0, 0, 1)).bucket).toBe(1);
    expect(encodeKeys(content(KEYS_CAPS[1].keys + 1, 0)).bucket).toBe(2);
    expect(encodeKeys(content(1, KEYS_CAPS[1].labels + 1)).bucket).toBe(2);
    expect(() => encodeKeys(content(KEYS_CAPS[2].keys + 1, 0))).toThrow(KeyringFormatError);
    expect(() => encodeKeys(content(1, KEYS_CAPS[2].labels + 1))).toThrow(KeyringFormatError);
    expect(() => encodeKeys(content(1, 1, 0))).toThrow(/unlockers/);
    expect(() => encodeKeys(content(1, 1, 9))).toThrow(/unlockers/);
    expect(() => encodePending({ keyringId: RID, votes: Array.from({ length: PENDING_CAPS[2].votes + 1 }, (_, i) => vote(i)) })).toThrow(KeyringFormatError);
  });
  it('refuses duplicates, bad padding, a wrong bucket and another kind', () => {
    const c = content(2, 1, 1);
    expect(() => encodeKeys({ ...c, keys: [c.keys[0]!, { ...c.keys[0]!, label: 'x' }] })).toThrow(/twice/);
    expect(() => encodeKeys({ ...c, unlockers: [c.unlockers[0]!, c.unlockers[0]!] })).toThrow(/twice/);
    const { plaintext } = encodeKeys(c);
    const bad = plaintext.slice();
    bad[bad.length - 1] = 1;
    expect(() => decodeKeys(bad, 1)).toThrow(/padding/);
    expect(() => decodeKeys(plaintext, 2)).toThrow();
    const p = encodePending({ keyringId: RID, votes: [vote(1)] }).plaintext;
    expect(() => decodeKeys(p, 1)).toThrow(/kind/);
  });
  it('normalizes labels to 32 UTF-8 bytes on a character boundary', () => {
    expect(normalizeLabel('  node\u0007 one  ')).toBe('node one');
    const n = normalizeLabel('€'.repeat(20)); // 3 bytes each
    expect(new TextEncoder().encode(n).length).toBe(30);
  });
});

describe('keyring sealing', () => {
  const pk = recipientFromPrf(randomBytes(32));
  const seed = seedUnlocker(SeedWallet.fromPhrase(PHRASE, 'testnet').entropy(), 'testnet', owner);
  const seal = (c: KeysContent, recipients: Uint8Array[]) => {
    const { bucket, plaintext } = encodeKeys(c);
    return sealKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, bucket, plaintext, recipients });
  };
  it('has the same size whatever it holds (1 key or 32, 1 unlocker or 8)', () => {
    const a = seal(content(1, 0, 1), [pk.publicKey]);
    const b = seal(content(32, 24, 2), [pk.publicKey, seed.publicKey]);
    for (const s of [a, b]) {
      expect(s.wraps.length).toBe(WRAPS_LENGTH);
      expect(s.chunks.map((c) => c.length)).toEqual([CHUNK_LENGTH]);
    }
    expect(seal(content(33, 0, 1), [pk.publicKey]).chunks.map((c) => c.length)).toEqual([CHUNK_LENGTH, CHUNK_LENGTH, CHUNK_LENGTH]);
  });
  it('opens with each unlocker, not with another key; a fresh key K every time', () => {
    const c = content(3, 2, 2);
    const s1 = seal(c, [pk.publicKey, seed.publicKey]);
    const s2 = seal(c, [pk.publicKey, seed.publicKey]);
    expect(bytesToHex(s1.chunks[0]!)).not.toBe(bytesToHex(s2.chunks[0]!));
    for (const sk of [pk.privateKey, seed.privateKey]) {
      const pt = openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, sealed: s1, recipientPrivateKey: sk });
      expect(decodeKeys(pt, 1).keys.length).toBe(3);
    }
    expect(() => openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, sealed: s1, recipientPrivateKey: recipientFromPrf(randomBytes(32)).privateKey })).toThrow(KeyringLockedError);
  });
  it('binds contract, owner, kind and wraps (no cut-and-paste between documents)', () => {
    const s = seal(content(1, 0, 1), [pk.publicKey]);
    const sk = pk.privateKey;
    expect(() => openKeyring({ contractId: randomBytes(32), ownerId: owner, kind: KeyringKind.KEYS, sealed: s, recipientPrivateKey: sk })).toThrow(KeyringLockedError);
    expect(() => openKeyring({ contractId: contract, ownerId: randomBytes(32), kind: KeyringKind.KEYS, sealed: s, recipientPrivateKey: sk })).toThrow(KeyringLockedError);
    expect(() => openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.PENDING, sealed: s, recipientPrivateKey: sk })).toThrow(KeyringLockedError);
    // swap an unused (random) slot: the body's AAD covers all wraps
    const other = seal(content(1, 0, 1), [pk.publicKey]);
    const wraps = s.wraps.slice();
    for (let i = 0; i < SLOT_COUNT; i++) {
      const w = wraps.slice();
      w.set(other.wraps.subarray(i * SLOT_LENGTH, (i + 1) * SLOT_LENGTH), i * SLOT_LENGTH);
      expect(() => openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, sealed: { ...s, wraps: w }, recipientPrivateKey: sk })).toThrow();
    }
    const body = s.chunks[0]!.slice();
    body[100] = body[100]! ^ 1;
    expect(() => openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, sealed: { ...s, chunks: [body] }, recipientPrivateKey: sk })).toThrow(/decrypt/);
    expect(() => openKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, sealed: { ...s, bucket: 2 }, recipientPrivateKey: sk })).toThrow(/shape/);
  });
  it('derives the seed unlocker per network and identity', () => {
    const e = SeedWallet.fromPhrase(PHRASE, 'testnet').entropy();
    const a = seedUnlocker(e, 'testnet', owner).publicKey;
    expect(bytesToHex(seedUnlocker(e, 'testnet', owner).publicKey)).toBe(bytesToHex(a));
    expect(bytesToHex(seedUnlocker(e, 'mainnet', owner).publicKey)).not.toBe(bytesToHex(a));
    expect(bytesToHex(seedUnlocker(e, 'testnet', randomBytes(32)).publicKey)).not.toBe(bytesToHex(a));
  });
});

class MemStore implements KeyringStore {
  docs = new Map<string, KeyringDoc>();
  writes = 0;
  async get(o: string, kind: number) {
    return this.docs.get(`${o}/${kind}`) ?? null;
  }
  async put({ ownerId: o, kind, sealed, existing }: Parameters<KeyringStore['put']>[0]) {
    this.writes++;
    const cur = this.docs.get(`${o}/${kind}`);
    if (existing && (!cur || cur.revision !== existing.revision)) throw new Error('stale revision');
    if (!existing && cur) throw new Error('duplicate unique index');
    const d = { id: cur?.id ?? toBase58(randomBytes(32)), ownerId: o, revision: (cur?.revision ?? 0) + 1, kind, sealed };
    this.docs.set(`${o}/${kind}`, d);
    return { id: d.id, revision: d.revision };
  }
  async remove({ doc }: Parameters<KeyringStore['remove']>[0]) {
    this.docs.delete(`${doc.ownerId}/${doc.kind}`);
  }
}

const seedSession = (): Session =>
  makeSession({ network: 'testnet', identityId: ownerId, identityIndex: 0, keyId: 2, securityLevel: 2, source: 'seed', privateKey: randomBytes(32), wallet: SeedWallet.fromPhrase(PHRASE, 'testnet') });
const keySession = (): Session => makeSession({ network: 'testnet', identityId: ownerId, identityIndex: null, keyId: 2, securityLevel: 2, source: 'key', privateKey: randomBytes(32), wallet: null });

describe('keyring on Platform (in-memory store)', () => {
  it('seed: create, sign out, sign in again, restore; then add a passkey and open with it', async () => {
    const store = new MemStore();
    const ctx = { store, contractId };
    const s1 = seedSession();
    const seed1 = seedUnlockKey(s1)!;
    expect(await loadKeyring(ctx, ownerId, seed1)).toBeNull();
    const k = emptyKeyring(ownerId, []);
    addUnlocker(k, seed1);
    k.content.keys.push({ privateKey: key(7), compressed: true, label: 'my key' });
    k.content.labels.push({ proTxHash: 'ab'.repeat(32), label: 'node 1' });
    await saveKeys(ctx, s1, k);
    k.pending.votes.push(vote(1));
    await savePending(ctx, s1, k);
    k.close();
    expect(k.content.keys[0]!.privateKey.every((b) => b === 0)).toBe(true);
    s1.end();
    seed1.wipe();

    const s2 = seedSession();
    const seed2 = seedUnlockKey(s2)!;
    const r = (await loadKeyring(ctx, ownerId, seed2))!;
    expect(r.authenticated).toBe(true);
    expect(bytesToHex(r.content.keys[0]!.privateKey)).toBe(bytesToHex(key(7)));
    expect(r.content.labels).toEqual([{ proTxHash: 'ab'.repeat(32), label: 'node 1' }]);
    expect(r.pending.votes.length).toBe(1);

    const prf = randomBytes(32);
    addUnlocker(r, passkeyUnlockKey(prf));
    await saveKeys(ctx, s2, r);
    await savePending(ctx, s2, r);
    expect(store.docs.get(`${ownerId}/0`)!.revision).toBe(2);
    const viaPasskey = (await loadKeyring(ctx, ownerId, passkeyUnlockKey(prf)))!;
    expect(viaPasskey.authenticated).toBeNull();
    expect(viaPasskey.openedWith).toBe(UnlockerType.PASSKEY);
    expect(viaPasskey.pending.votes.length).toBe(1);
    // the passkey session that also holds the seed can check authenticity
    expect((await loadKeyring(ctx, ownerId, passkeyUnlockKey(prf), seedUnlockKey(s2)))!.authenticated).toBe(true);
  });

  it('a key-paste session has no unlocker; a removed unlocker cannot open later writes', async () => {
    expect(seedUnlockKey(keySession())).toBeNull();
    const store = new MemStore();
    const ctx = { store, contractId };
    const s = seedSession();
    const prfA = randomBytes(32);
    const k = emptyKeyring(ownerId, []);
    addUnlocker(k, seedUnlockKey(s)!);
    addUnlocker(k, passkeyUnlockKey(prfA));
    await saveKeys(ctx, s, k);
    removeUnlocker(k, passkeyUnlockKey(prfA).pair.publicKey);
    await saveKeys(ctx, s, k);
    await expect(loadKeyring(ctx, ownerId, passkeyUnlockKey(prfA))).rejects.toThrow(KeyringLockedError);
    expect(() => removeUnlocker(k, k.content.unlockers[0]!.recipientKey)).toThrow(/at least one/);
  });

  it('flags a planted keyring (sealed to the passkey, not listing this seed)', async () => {
    const store = new MemStore();
    const ctx = { store, contractId };
    const prf = randomBytes(32);
    const attacker = recipientFromPrf(randomBytes(32));
    // the attacker knows only the public passkey recipient key (it is in forum.vault)
    const planted = emptyKeyring(ownerId, [
      { type: UnlockerType.PASSKEY, recipientKey: passkeyUnlockKey(prf).pair.publicKey, addedAt: 1 },
      { type: UnlockerType.PASSKEY, recipientKey: attacker.publicKey, addedAt: 1 },
    ]);
    await saveKeys(ctx, keySession(), planted);
    const s = seedSession();
    const r = (await loadKeyring(ctx, ownerId, passkeyUnlockKey(prf), seedUnlockKey(s)))!;
    expect(r.authenticated).toBe(false);
    expect(r.content.unlockers.length).toBe(2);
  });

  it('refuses to write for another identity or with an ended session', async () => {
    const ctx = { store: new MemStore(), contractId };
    const s = seedSession();
    const k = emptyKeyring(toBase58(randomBytes(32)), [unlocker()]);
    await expect(saveKeys(ctx, s, k)).rejects.toThrow(/another identity/);
    s.end();
    await expect(saveKeys(ctx, s, emptyKeyring(ownerId, [unlocker()]))).rejects.toThrow(/ended/);
  });
});

describe('review fixes', () => {
  it('filler wrap slots start with a real X25519 public key (top bit clear), like used ones', () => {
    const { bucket, plaintext } = encodeKeys(content(1, 0, 1));
    const s = sealKeyring({ contractId: contract, ownerId: owner, kind: KeyringKind.KEYS, bucket, plaintext, recipients: [recipientFromPrf(randomBytes(32)).publicKey] });
    for (let i = 0; i < SLOT_COUNT; i++) expect(s.wraps[i * SLOT_LENGTH + 31]! & 0x80).toBe(0);
  });
  it('a PENDING document that does not carry the keyring id is ignored; generation increments per write', async () => {
    const store = new MemStore();
    const ctx = { store, contractId };
    const s = seedSession();
    const prf = randomBytes(32);
    const k = emptyKeyring(ownerId, []);
    addUnlocker(k, seedUnlockKey(s)!);
    addUnlocker(k, passkeyUnlockKey(prf));
    await saveKeys(ctx, s, k);
    await saveKeys(ctx, s, k);
    expect(k.content.generation).toBe(2);
    // planted: sealed to the (public) passkey key with another keyring id and an attacker relay
    const planted = emptyKeyring(ownerId, [{ type: UnlockerType.PASSKEY, recipientKey: passkeyUnlockKey(prf).pair.publicKey, addedAt: 1 }]);
    planted.pending.votes.push({ ...vote(1, ['https://attacker.example']) });
    await savePending(ctx, keySession(), planted);
    const r = (await loadKeyring(ctx, ownerId, passkeyUnlockKey(prf)))!;
    expect(r.pending.votes).toEqual([]);
    expect(r.content.generation).toBe(2);
    expect(bytesToHex(r.openedBy!)).toBe(bytesToHex(passkeyUnlockKey(prf).pair.publicKey));
  });
  it('refuses a pending vote with an impossible outcome', () => {
    expect(() => encodePending({ keyringId: RID, votes: [{ ...vote(1), outcome: 9 }] })).toThrow(/outcome/);
  });
});

describe('evo store glue', () => {
  it('the K1 query passes the PV13 lint on byOwnerKind', () => {
    const q = keyringQuery(contractId, ownerId, 0);
    const r = lintQuery(forumSchemas as unknown as ContractSchemas, q as never);
    expect(r.errors).toEqual([]);
    expect(r.index).toBe('byOwnerKind');
  });
  it('parses the JSON form of a document', () => {
    const wraps = randomBytes(640);
    const c0 = randomBytes(4096);
    const d = keyringDocFromJson({ $id: 'X', $ownerId: ownerId, $revision: 3, kind: 0, version: 1, bucket: 1, wraps: toBase64(wraps), c0: toBase64(c0) });
    expect(d.sealed.chunks.length).toBe(1);
    expect(bytesToHex(d.sealed.wraps)).toBe(bytesToHex(wraps));
    expect(d.revision).toBe(3);
  });
  it('the contract type matches the sizes the code writes', () => {
    const t = (forumSchemas as unknown as Record<string, { properties: Record<string, { minItems?: number; maxItems?: number }>; required: string[] }>).keyring!;
    expect(t.properties.wraps!.minItems! <= WRAPS_LENGTH && WRAPS_LENGTH <= t.properties.wraps!.maxItems!).toBe(true);
    for (const c of ['c0', 'c1', 'c2']) expect(t.properties[c]!.maxItems! >= CHUNK_LENGTH).toBe(true);
    expect(t.required).toEqual(['kind', 'version', 'bucket', 'wraps', 'c0']);
  });
});
