// The one document writer (evo.ts writeDocument) and addKeys against a small stateful fake of Platform: a chain of heights with
// identity-contract nonces (top + missing bits, rs-dpp rules), documents, scripted broadcast outcomes ("landed but the client saw an
// error", refusals before execution) and proved reads that can lag behind the tip or fail. Sleeps are injected, so nothing waits.
import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, identifierBytes, randomBytes, sha256d, toBase58 } from '../src/bytes.ts';
import { classifySend, createEvoPlatform, nonceConsumed } from '../src/evo.ts';
import { publicKeyOf } from '../src/keys.ts';
import type { DocValue, DocumentWrite, SigningKey } from '../src/platform.ts';

const owner = toBase58(randomBytes(32));
const contract = toBase58(randomBytes(32));
const key: SigningKey = { id: 2, purpose: 0, securityLevel: 2, type: 0, privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const err = (message: string, code = -1, name = 'Generic') => ({ message, code, name }); // WASM errors are plain objects
const timeout = () => err('Failed to wait for state transition result: timeout reached', -1, 'TimeoutReached');
const MASK = 0xff_ffff_ffffn;
const nonceErr = (what: string) => err(`Identity x is trying to set an invalid identity nonce. The current identity nonce is 3, we are setting 4, error is ${what}`, 40204, 'StateTransitionBroadcastError');

type Doc = { id: string; type: string; revision: bigint; properties: Record<string, unknown> };
type State = { height: bigint; nonce: bigint; docs: Map<string, Doc>; keys: Map<number, Uint8Array>; revision: bigint };
type Tx = { kind: 'create' | 'replace' | 'delete'; id: string; type: string; nonce: bigint; revision?: bigint; properties?: Record<string, unknown>; pv?: number };
/** `hang`: executes, then the result stream stays silent for that many real ms before answering (`after` then rejects it). */
type Send = { before?: unknown; after?: unknown; hang?: number } | void;

function chain(o: {
  version?: number;
  /** What sdk.version() answers (right after connect it can lag the network). */
  sdkVersion?: number;
  docs?: Doc[];
  /** Broadcast `n` (0 first): `before` refuses without executing, `after` executes and then throws. */
  send?: (n: number, tx: Tx) => Send;
  /** Proved read `n` of a kind: how many heights behind the tip it is, or an error to throw. */
  read?: (kind: 'doc' | 'nonce' | 'identity', n: number) => number | { error: unknown } | void;
  update?: (n: number) => Send;
  /** Multiplies how long each sleep takes on the fake clock. */
  slow?: number;
}) {
  const version = o.version ?? 14;
  const clone = (s: State): State => ({ ...s, docs: new Map([...s.docs].map(([k, d]) => [k, { ...d, properties: { ...d.properties } }])), keys: new Map(s.keys) });
  const history: State[] = [{ height: 1n, nonce: 3n, docs: new Map((o.docs ?? []).map((d) => [d.id, d])), keys: new Map([[2, publicKeyOf(key.privateKey)]]), revision: 1n }];
  const tip = () => history[history.length - 1]!;
  const commit = (s: State) => history.push({ ...s, height: tip().height + 1n });
  const reads = { doc: 0, nonce: 0, identity: 0 };
  const at = (kind: keyof typeof reads) => {
    const n = reads[kind]++;
    const r = o.read?.(kind, n);
    if (r && typeof r === 'object') throw r.error;
    return history[Math.max(0, history.length - 1 - (r ?? 0))]!;
  };
  const log = { sends: [] as unknown[], signs: 0, updates: 0, refreshes: 0, answered: 0 };

  const apply = (tx: Tx) => {
    const s = clone(tip());
    // rs-dpp identity_nonce.rs: the low 40 bits are the top nonce, bit 40 + i flags nonce top - 1 - i as not used yet
    const top = s.nonce & MASK;
    let missing = s.nonce >> 40n;
    const n = tx.nonce;
    if (n > top + 24n) throw nonceErr('nonce too far in future');
    if (n === top) throw nonceErr('nonce already present at tip');
    if (n < top && top - n > 24n) throw nonceErr('nonce too far in past');
    if (n < top && !(missing & (1n << (top - n - 1n)))) throw nonceErr('nonce already present in past');
    const d = s.docs.get(tx.id);
    if (tx.kind === 'create') {
      if (d) throw err('Document already present', 40100, 'StateTransitionBroadcastError');
      s.docs.set(tx.id, { id: tx.id, type: tx.type, revision: 1n, properties: tx.properties! });
    } else if (!d) throw err(`Document ${tx.id} not found`, 40101, 'StateTransitionBroadcastError');
    else if (tx.kind === 'replace') {
      if (tx.revision !== d.revision + 1n) throw err('Invalid document revision', 40106, 'StateTransitionBroadcastError');
      s.docs.set(tx.id, { ...d, revision: tx.revision, properties: tx.properties! });
    } else s.docs.delete(tx.id);
    if (n < top) missing &= ~(1n << (top - n - 1n));
    else missing = ((missing << (n - top)) | ((1n << (n - top - 1n)) - 1n)) & 0xff_ffffn;
    s.nonce = (missing << 40n) | (n > top ? n : top);
    commit(s);
  };

  class Obj {
    free() {}
  }
  const props = (doc: Record<string, unknown>) => Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('$')));
  const base = (id: string, nonce: bigint) => ({ id: { toString: () => id }, identityContractNonce: nonce });
  const evo = {
    IdentitySigner: class extends Obj {
      addKey() {}
    },
    Identifier: class extends Obj {},
    IdentityPublicKeyInCreation: class extends Obj {
      constructor(readonly o: { keyId: number; data: Uint8Array }) {
        super();
      }
    },
    PrivateKey: { fromBytes: () => new Obj() },
    Document: { fromObject: (doc: Record<string, unknown>) => doc },
    DocumentCreateTransition: class {
      base: ReturnType<typeof base>;
      tx: Tx;
      constructor({ document: d, identityContractNonce: n, platformVersion: pv }: { document: Record<string, unknown>; identityContractNonce: bigint; platformVersion: number }) {
        const pre = concatBytes(d.$dataContractId as Uint8Array, d.$ownerId as Uint8Array, new TextEncoder().encode(d.$type as string), d.$entropy as Uint8Array);
        // PV13: sha256d(contract || owner || type || entropy); the fake PV14 id also commits to the nonce
        const id = toBase58(sha256d(pv <= 13 ? pre : concatBytes(pre, new TextEncoder().encode(String(n)))));
        this.base = base(id, n);
        this.tx = { kind: 'create', id, type: d.$type as string, nonce: n, properties: props(d), pv };
      }
      toDocumentTransition() {
        return this.tx;
      }
    },
    DocumentReplaceTransition: class {
      tx: Tx;
      constructor({ document: d, identityContractNonce: n }: { document: Record<string, unknown>; identityContractNonce: bigint }) {
        this.tx = { kind: 'replace', id: toBase58(d.$id as Uint8Array), type: d.$type as string, nonce: n, revision: (d.$revision as bigint) + 1n, properties: props(d) };
      }
      toDocumentTransition() {
        return this.tx;
      }
    },
    DocumentDeleteTransition: class {
      tx: Tx;
      constructor({ document: d, identityContractNonce: n }: { document: Doc; identityContractNonce: bigint }) {
        this.tx = { kind: 'delete', id: d.id, type: d.type, nonce: n };
      }
      toDocumentTransition() {
        return this.tx;
      }
    },
    BatchedTransition: class {
      constructor(readonly tx: Tx) {}
    },
    BatchTransition: {
      fromBatchedTransitions: ([b]: Array<{ tx: Tx }>) => ({
        toStateTransition: () => ({
          tx: b!.tx,
          signed: false,
          sign() {
            if (this.signed) throw new Error('signed twice');
            this.signed = true;
            log.signs++;
          },
        }),
      }),
    },
    PlatformVersion: { latest: () => 'latest' },
  };
  const identityAt = (s: State) => ({
    revision: s.revision,
    getPublicKeyById: (id: number) => (s.keys.has(id) ? { id, toObject: () => ({ id, purpose: 0, securityLevel: 2, type: 0, data: s.keys.get(id)! }) } : undefined),
  });
  const sdk = {
    version: () => o.sdkVersion ?? version,
    wasm: { refreshIdentityNonce: async () => void log.refreshes++ },
    identities: {
      fetchWithProof: async () => ({ data: identityAt(at('identity')) }),
      contractNonceWithProof: async () => {
        const s = at('nonce');
        return { data: s.nonce, metadata: { height: s.height, protocolVersion: version } };
      },
      update: async ({ identity, addPublicKeys }: { identity: { revision: bigint }; addPublicKeys: Array<{ o: { keyId: number; data: Uint8Array } }> }) => {
        const script = o.update?.(log.updates++) ?? {};
        if (script.before) throw script.before;
        const s = clone(tip());
        if (identity.revision !== s.revision) throw err('Invalid identity revision', 40203, 'StateTransitionBroadcastError');
        for (const k of addPublicKeys) {
          if (s.keys.has(k.o.keyId)) throw err('Duplicated public key id', 40207, 'StateTransitionBroadcastError');
          s.keys.set(k.o.keyId, k.o.data);
        }
        s.revision++;
        commit(s);
        if (script.after) throw script.after;
      },
    },
    documents: {
      getWithProof: async (_c: string, _t: string, id: string) => {
        const s = at('doc');
        return { data: s.docs.get(id), metadata: { height: s.height } };
      },
    },
    stateTransitions: {
      broadcastAndWait: async (st: { tx: Tx; signed: boolean }) => {
        expect(st.signed).toBe(true);
        const script = o.send?.(log.sends.length, st.tx) ?? {};
        log.sends.push(st);
        if (script.before) throw script.before;
        apply(st.tx);
        if (script.hang) {
          await new Promise((r) => setTimeout(r, script.hang));
          log.answered++;
        }
        if (script.after) throw script.after;
      },
    },
  };
  // Sleeps take no real time; they advance a fake clock (the send budget), `slow` times their length.
  let clock = 0;
  const port = createEvoPlatform(evo as never, sdk as never, 'testnet', { sleep: async (ms) => void (clock += ms * (o.slow ?? 1)), now: () => clock });
  /** A write by someone else (another tab): takes the next nonce. */
  const foreign = () => commit({ ...clone(tip()), nonce: tip().nonce + 1n });
  /** Any other change on Platform (a new block). */
  const mutate = (f: (s: State) => void) => {
    const s = clone(tip());
    f(s);
    commit(s);
  };
  return { port, log, tip, reads, foreign, mutate };
}

const create = (data: Record<string, DocValue> = { body: 'x', fmt: 1 }): DocumentWrite => ({ action: 'create', contractId: contract, type: 'comment', data });
const docId = toBase58(randomBytes(32));
const stored = (revision = 3n, properties: Record<string, unknown> = { displayName: 'old' }): Doc => ({ id: docId, type: 'profile', revision, properties });
const write = (c: ReturnType<typeof chain>, op: DocumentWrite) => c.port.writeDocument({ ownerId: owner, key, op });

describe('nonce rules', () => {
  it('classifies "too far in future" apart from a spent nonce, lag, refusals and ambiguous outcomes', () => {
    expect(classifySend(nonceErr('nonce too far in future'))).toBe('future');
    expect(classifySend(nonceErr('nonce already present at tip'))).toBe('past');
    expect(classifySend(nonceErr('nonce already present in past'))).toBe('past');
    expect(classifySend(nonceErr('nonce too far in past'))).toBe('past');
    expect(classifySend(err('Document x not found', 40101, 'StateTransitionBroadcastError'))).toBe('lag');
    expect(classifySend(err('Duplicate unique index', 40105, 'StateTransitionBroadcastError'))).toBe('refused');
    expect(classifySend(timeout())).toBe('ambiguous');
    expect(classifySend(err('execution not proved', -1, 'ExecutionNotProved'))).toBe('ambiguous');
    expect(classifySend(err('transport error: unavailable', -1, 'DapiClientError'))).toBe('ambiguous');
    expect(classifySend(err('tx already exists in cache', -1, 'AlreadyExists'))).toBe('ambiguous');
    expect(classifySend(err('bad argument', -1, 'InvalidArgument'))).toBe('refused');
    expect(classifySend(err('serialization', -1, 'SerializationError'))).toBe('refused');
  });

  it('knows when a nonce can never be applied again (top, used in the window, more than 24 below)', () => {
    expect(nonceConsumed(10n, 11n)).toBe(false);
    expect(nonceConsumed(10n, 10n)).toBe(true);
    expect(nonceConsumed(10n, 9n)).toBe(true);
    expect(nonceConsumed(40n, 10n)).toBe(true);
    const missing9 = 10n | (1n << 40n); // nonce 9 (one below the top) flagged missing
    expect(nonceConsumed(missing9, 9n)).toBe(false);
    expect(nonceConsumed(missing9, 8n)).toBe(true);
  });
});

describe('writeDocument: creates', () => {
  it('builds the transition once with nonce = proved contract nonce + 1; the id is known up front; integers as bigint', async () => {
    const c = chain({ version: 14 });
    const r = await write(c, create());
    expect(c.log.signs).toBe(1);
    const tx = (c.log.sends[0] as { tx: Tx }).tx;
    expect(tx.nonce).toBe(4n);
    expect(tx.properties!.fmt).toBe(1n);
    expect(r).toEqual({ id: tx.id, revision: 1 });
    expect(c.tip().docs.has(r.id)).toBe(true);
  });

  it('derives the id for the protocol the proved read reports, not a lagging sdk.version() (13 right after connect on PV14)', async () => {
    const pv14 = chain({ version: 14, sdkVersion: 13 });
    const r = await write(pv14, create());
    const tx = (pv14.log.sends[0] as { tx: Tx }).tx;
    expect(tx.pv).toBe(14);
    expect(r.id).toBe(tx.id);
    const pv13 = chain({ version: 13 });
    const tx13 = await write(pv13, create()).then(() => (pv13.log.sends[0] as { tx: Tx }).tx);
    expect(tx13.pv).toBe(13); // the real id rules per version are pinned in evo-wasm.test.ts
  });

  it('PV14: an ambiguous error before execution re-sends the SAME signed transition; one document', async () => {
    const c = chain({ send: (n) => (n === 0 ? { before: timeout() } : undefined) });
    const r = await write(c, create());
    expect(c.log.sends).toHaveLength(2);
    expect(c.log.sends[0]).toBe(c.log.sends[1]);
    expect(c.log.signs).toBe(1);
    expect([...c.tip().docs.keys()]).toEqual([r.id]);
  });

  it('PV14: landed but the client saw a timeout, and the read right after lags: the re-send ("nonce already present") settles it, one document', async () => {
    const c = chain({ send: (n) => (n === 0 ? { after: timeout() } : undefined), read: (k, n) => (k === 'doc' && n < 2 ? 1 : 0) });
    const r = await write(c, create());
    expect(c.log.signs).toBe(1);
    expect(c.tip().docs.size).toBe(1);
    expect(c.tip().docs.has(r.id)).toBe(true);
  });

  it('"too far in future" re-sends the same transition, never re-signed with a higher nonce', async () => {
    const c = chain({ send: (n) => (n < 2 ? { before: nonceErr('nonce too far in future') } : undefined) });
    await write(c, create());
    expect(c.log.sends).toHaveLength(3);
    expect(new Set(c.log.sends).size).toBe(1);
    expect(c.log.signs).toBe(1);
    expect(c.reads.nonce).toBe(1);
  });

  it('PV13 duplicate path: after a landed attempt, a re-send refused 40100 ("already present") is success once a failing, lagging read finally finds the id', async () => {
    // send 0 lands, the client sees a timeout; send 1 is refused 40100 (the document exists); the next reads fail, lag, then find it
    const c = chain({
      version: 13,
      send: (n) => (n === 0 ? { after: timeout() } : n === 1 ? { before: err('Document already present', 40100, 'StateTransitionBroadcastError') } : undefined),
      read: (k, n) => (k !== 'doc' ? 0 : n === 0 ? 1 : n === 1 ? { error: err('transport error', -1, 'DapiClientError') } : n === 2 ? 1 : 0),
    });
    const r = await write(c, create());
    expect(c.tip().docs.has(r.id)).toBe(true);
    expect(c.tip().docs.size).toBe(1);
  });

  it('a first create refused by consensus (a unique index) fails at once; a refusal after an earlier send fails only when every read misses', async () => {
    const first = chain({ send: () => ({ before: err('Duplicate unique index', 40105, 'StateTransitionBroadcastError') }) });
    await expect(write(first, create())).rejects.toMatchObject({ message: expect.stringMatching(/unique index/) });
    expect(first.reads.doc).toBe(0);
    const later = chain({ send: (n) => (n === 0 ? { before: timeout() } : { before: err('Duplicate unique index', 40105, 'StateTransitionBroadcastError') }) });
    await expect(write(later, create())).rejects.toMatchObject({ message: expect.stringMatching(/unique index/) });
    expect(later.reads.doc).toBeGreaterThanOrEqual(5);
    expect(later.tip().docs.size).toBe(0);
  });
});

describe('writeDocument: a silent result stream (D-041)', () => {
  it('a create is done once a proved read shows it, without waiting for broadcastAndWait to answer', async () => {
    const c = chain({ send: () => ({ hang: 400 }) });
    const r = await write(c, create());
    expect(c.log.answered).toBe(0); // returned before the wait answered
    expect(c.tip().docs.has(r.id)).toBe(true);
    expect(c.log.sends).toHaveLength(1);
  });

  it('the same for a replace and a delete; a wait that then times out changes nothing', async () => {
    const rep = chain({ docs: [stored()], send: () => ({ hang: 400, after: timeout() }) });
    await expect(write(rep, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'new' } })).resolves.toEqual({ id: docId, revision: 4 });
    expect(rep.log.answered).toBe(0);
    const del = chain({ docs: [stored()], send: () => ({ hang: 400, after: timeout() }) });
    await expect(write(del, { action: 'delete', contractId: contract, type: 'profile', id: docId })).resolves.toEqual({ id: docId });
    expect(del.log.answered).toBe(0);
    expect(del.tip().docs.has(docId)).toBe(false);
    await new Promise((r) => setTimeout(r, 450)); // the late timeouts are absorbed, not unhandled
  });

  it('reads that do not show the write (a lagging node) never settle it: the wait still decides', async () => {
    const c = chain({ send: () => ({ hang: 50 }), read: (k) => (k === 'doc' ? 1 : 0) }); // every doc read is one block behind
    const r = await write(c, create());
    expect(c.reads.doc).toBeGreaterThan(0); // proved reads ran while the wait was silent
    expect(c.log.answered).toBe(1);
    expect(c.tip().docs.has(r.id)).toBe(true);
  });
});

describe('writeDocument: spent nonces', () => {
  it('"nonce already present" after a lagging nonce read: a create signs again with a fresh nonce once its own id is proved absent', async () => {
    const c = chain({ read: (k, n) => (k === 'nonce' && n === 0 ? 1 : 0) });
    c.foreign(); // another tab took nonce 4; our first nonce read is a height behind it
    const r = await write(c, create());
    expect(c.log.signs).toBe(2);
    expect((c.log.sends[1] as { tx: Tx }).tx.nonce).toBe(5n);
    expect([...c.tip().docs.keys()]).toEqual([r.id]);
  });

  it('a create whose nonce is not proved spent by someone else is never signed again (no second document)', async () => {
    // our first send lands but reports a timeout; every doc read lags behind it, so the writer cannot prove ours did not land
    const c = chain({ send: (n) => (n === 0 ? { after: timeout() } : undefined), read: (k) => (k === 'doc' ? 1 : 0) });
    await expect(write(c, create())).rejects.toThrow(/did not confirm/);
    expect(c.log.signs).toBe(1);
    expect(c.tip().docs.size).toBe(1);
  });

  it('replace and delete sign again with a fresh nonce after "nonce already present" / "too far in past" (they cannot apply twice)', async () => {
    const c = chain({ docs: [stored()], read: (k, n) => (k === 'nonce' && n === 0 ? 1 : 0) });
    c.foreign();
    expect(await write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } })).toEqual({ id: docId, revision: 4 });
    expect(c.log.signs).toBe(2);
    const d = chain({ docs: [stored()], send: (n) => (n === 0 ? { before: nonceErr('nonce too far in past') } : undefined) });
    expect(await write(d, { action: 'delete', contractId: contract, type: 'profile', id: docId })).toEqual({ id: docId });
    expect(d.log.signs).toBe(2);
    expect(d.tip().docs.has(docId)).toBe(false);
  });

  it('"already present" while the proved nonce still flags ours as unused (that read lags the refusing node): re-send, never re-sign a create', async () => {
    const c = chain({ read: (k, n) => (k === 'nonce' && n === 0 ? 1 : 0), send: (n) => (n === 0 ? { before: nonceErr('nonce already present in past') } : undefined) });
    c.mutate((s) => (s.nonce = 5n | (1n << 40n))); // top 5, nonce 4 not used yet; our first read is a block behind (3) -> we sign 4
    const r = await write(c, create());
    expect(c.log.signs).toBe(1);
    expect((c.log.sends[1] as { tx: Tx }).tx.nonce).toBe(4n);
    expect(c.tip().docs.has(r.id)).toBe(true);
  });

  it('a spent nonce on the last attempt does not sign a transition that would never be sent', async () => {
    const c = chain({ docs: [stored()], send: () => ({ before: nonceErr('nonce already present at tip') }) });
    await expect(write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } })).rejects.toThrow(/did not confirm/);
    expect(c.log.signs).toBe(c.log.sends.length);
  });
});

describe('writeDocument: replace', () => {
  it('sends revision + 1 and re-sends the same transition on a lagging node (40101)', async () => {
    const c = chain({ docs: [stored()], send: (n) => (n === 0 ? { before: err('Document not found', 40101, 'StateTransitionBroadcastError') } : undefined) });
    const r = await write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } });
    expect(r.revision).toBe(4);
    expect(c.log.sends).toHaveLength(2);
    expect(c.log.signs).toBe(1);
    expect(c.tip().docs.get(docId)!.revision).toBe(4n);
  });

  it('an earlier attempt that landed: the refusal (stale revision) is success when a proved read shows revision + 1 with our data', async () => {
    const op: DocumentWrite = { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a', $updatedAt: 5 } };
    const c = chain({ docs: [stored(4n, { displayName: 'a' })] });
    expect(await write(c, op)).toEqual({ id: docId, revision: 4 });
    const theirs = chain({ docs: [stored(4n, { displayName: 'someone else' })] });
    await expect(write(theirs, op)).rejects.toMatchObject({ message: expect.stringMatching(/revision/) });
    expect(theirs.reads.doc).toBe(1); // definitely not ours: no more reads
  });

  it('an ambiguous send, then a proved read showing someone else\'s revision: stops with that message, no more sends', async () => {
    const c = chain({ docs: [stored(4n, { displayName: 'other tab' })], send: () => ({ before: timeout() }) });
    await expect(write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } })).rejects.toThrow(/changed on Platform meanwhile/);
    expect(c.log.sends).toHaveLength(1);
  });

  it('a replace of a document that is not on Platform ends with a message saying so, not "it may still appear"', async () => {
    const c = chain({});
    await expect(write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } })).rejects.toThrow(/not on Platform/);
  });

  it('landed but the client saw ExecutionNotProved: settled by state, not re-applied', async () => {
    const c = chain({ docs: [stored()], send: (n) => (n === 0 ? { after: err('not proved', -1, 'ExecutionNotProved') } : undefined) });
    const r = await write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } });
    expect(r.revision).toBe(4);
    expect(c.log.sends).toHaveLength(1);
  });
});

describe('writeDocument: delete', () => {
  const del: DocumentWrite = { action: 'delete', contractId: contract, type: 'profile', id: docId };

  it('reads the document first; a delete that landed while the client saw an error is done once a read shows it absent above H0', async () => {
    // send 0 executes then times out; the next read lags (still present); the re-send is "nonce already present" -> read -> absent
    const c = chain({ docs: [stored()], send: (n) => (n === 0 ? { after: timeout() } : undefined), read: (k, n) => (k === 'doc' && n === 1 ? 1 : 0) });
    expect(await write(c, del)).toEqual({ id: docId });
    expect(c.tip().docs.has(docId)).toBe(false);
    expect(c.log.signs).toBe(1);
  });

  it('a re-send refused 40101 after the first landed is done (absent at a height above the pre-read)', async () => {
    const c = chain({ docs: [stored()], send: (n) => (n === 0 ? { after: err('transport', -1, 'DapiClientError') } : n === 1 ? { before: err('Document not found', 40101, 'StateTransitionBroadcastError') } : undefined), read: (k, n) => (k === 'doc' && n === 1 ? 1 : 0) });
    expect(await write(c, del)).toEqual({ id: docId });
  });

  it('retries a pre-read that lags (absent: the document is one block newer than that node) or fails, then deletes', async () => {
    const c = chain({ read: (k, n) => (k !== 'doc' ? 0 : n === 0 ? 1 : n === 1 ? { error: err('transport', -1, 'DapiClientError') } : 0) });
    c.mutate((s) => s.docs.set(docId, stored()));
    expect(await write(c, del)).toEqual({ id: docId });
    expect(c.reads.doc).toBeGreaterThanOrEqual(3);
    expect(c.tip().docs.has(docId)).toBe(false);
  });

  it('deleting a document that is already gone fails fast with a clear message and sends nothing', async () => {
    const c = chain({});
    await expect(write(c, del)).rejects.toThrow(/Nothing to delete/);
    expect(c.log.sends).toHaveLength(0);
    expect(c.log.signs).toBe(0);
  });

  it('a delete refused by lagging nodes every time is an error, never success', async () => {
    const c = chain({ docs: [stored()], send: () => ({ before: err('Document not found', 40101, 'StateTransitionBroadcastError') }) });
    await expect(write(c, del)).rejects.toThrow(/did not confirm/);
    expect(c.log.sends).toHaveLength(6);
    expect(c.tip().docs.has(docId)).toBe(true);
  });
});

describe('writeDocument: identity and key', () => {
  it('reads the identity again when a lagging node does not show the signing key yet (right after addKeys), or the read fails', async () => {
    const c = chain({ read: (k, n) => (k === 'identity' && n === 0 ? 1 : 0) });
    const pub = c.tip().keys.get(2)!;
    c.tip().keys.delete(2);
    c.mutate((s) => s.keys.set(2, pub)); // the key arrives one block later; the first read is a block behind
    await write(c, create());
    expect(c.reads.identity).toBe(2);
    const e = chain({ read: (k, n) => (k === 'identity' && n === 0 ? { error: err('timeout', -1, 'TimeoutReached') } : undefined) });
    await write(e, create());
    expect(e.reads.identity).toBe(2);
  });

  it('a local SDK error (InvalidArgument) is never re-sent; it fails once proved reads show nothing stored', async () => {
    const c = chain({ send: () => ({ before: err('invalid document', -1, 'InvalidArgument') }) });
    await expect(write(c, create())).rejects.toThrow(/invalid document/);
    expect(c.log.sends).toHaveLength(1);
  });

  it('a local SDK error after the transition executed (result conversion) is settled by a proved read: done, one document', async () => {
    const c = chain({ send: () => ({ after: err('could not convert the proof result', -1, 'SerializationError') }) });
    const r = await write(c, create());
    expect(c.log.sends).toHaveLength(1);
    expect([...c.tip().docs.keys()]).toEqual([r.id]);
  });

  it('no new send starts after the 2-minute budget', async () => {
    const c = chain({ docs: [stored()], slow: 10, send: () => ({ before: timeout() }) }); // sleeps of 25, 50, 75 s
    await expect(write(c, { action: 'replace', contractId: contract, type: 'profile', id: docId, revision: 3, data: { displayName: 'a' } })).rejects.toThrow(/did not confirm/);
    expect(c.log.sends).toHaveLength(3);
  });

  it('refuses a wiped (all-zero) key and never touches the caller key', async () => {
    const c = chain({ docs: [stored()] });
    await expect(c.port.writeDocument({ ownerId: owner, key: { ...key, privateKey: new Uint8Array(32) }, op: { action: 'delete', contractId: contract, type: 'profile', id: docId } })).rejects.toThrow(/ended/);
    const k = { ...key, privateKey: key.privateKey.slice() };
    await c.port.writeDocument({ ownerId: owner, key: k, op: { action: 'delete', contractId: contract, type: 'profile', id: docId } });
    expect(bytesToHex(k.privateKey)).toBe(bytesToHex(key.privateKey));
  });
});

describe('addKeys', () => {
  const master: SigningKey = { id: 0, purpose: 0, securityLevel: 0, type: 0, privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 40) };
  const k3: SigningKey = { id: 3, purpose: 3, securityLevel: 1, type: 0, privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 80) };

  it('an update that landed while the client saw an error is done when a read shows the keys at the next revision', async () => {
    const c = chain({ update: (n) => (n === 0 ? { after: timeout() } : undefined) });
    await c.port.addKeys({ identityId: owner, master, keys: [k3] });
    expect(c.log.updates).toBe(1);
    expect(c.tip().revision).toBe(2n);
  });

  it('a spent identity nonce is retried after refreshIdentityNonce', async () => {
    const c = chain({ update: (n) => (n === 0 ? { before: nonceErr('nonce already present in past') } : undefined) });
    await c.port.addKeys({ identityId: owner, master, keys: [k3] });
    expect(c.log.refreshes).toBe(1);
    expect(c.log.updates).toBe(2);
  });

  it('a node with an older revision (40203) or without the identity yet (20000) is retried', async () => {
    for (const code of [40203, 20000]) {
      const c = chain({ update: (n) => (n === 0 ? { before: err('lagging', code, 'StateTransitionBroadcastError') } : undefined) });
      await c.port.addKeys({ identityId: owner, master, keys: [k3] });
      expect(c.log.updates).toBe(2);
      expect(c.tip().keys.has(3)).toBe(true);
    }
  });

  it('a duplicate-key refusal after an update that landed (the identity read before it lagged) is done', async () => {
    const c = chain({ update: (n) => (n === 0 ? { after: timeout() } : undefined), read: (k, n) => (k === 'identity' && n === 1 ? 1 : 0) });
    await c.port.addKeys({ identityId: owner, master, keys: [k3] }); // 2nd update: stale identity -> 40203 -> re-read shows the keys
    expect(c.tip().revision).toBe(2n);
    const d = chain({ update: (n) => (n === 0 ? { after: timeout() } : n === 1 ? { before: err('Duplicated public key id', 40207, 'StateTransitionBroadcastError') } : undefined), read: (k, n) => (k === 'identity' && n === 1 ? 1 : 0) });
    await d.port.addKeys({ identityId: owner, master, keys: [k3] });
    expect(d.log.updates).toBe(2);
  });

  it('keys already on the identity need no update', async () => {
    const c = chain({});
    c.mutate((s) => s.keys.set(3, publicKeyOf(k3.privateKey)));
    await c.port.addKeys({ identityId: owner, master, keys: [k3] });
    expect(c.log.updates).toBe(0);
  });

  it('does not retry an unrelated "not found" refusal or a local error', async () => {
    for (const e of [err('public key with id 9 not found in signer', 10000, 'StateTransitionBroadcastError'), err('public key 9 not found in signer', -1, 'InvalidArgument')]) {
      const c = chain({ update: () => ({ before: e }) });
      await expect(c.port.addKeys({ identityId: owner, master, keys: [k3] })).rejects.toThrow(/not found in signer/);
      expect(c.log.updates).toBe(1);
      // the read before the update, then one settle read after a consensus refusal, five after a local error (it may follow an execution)
      expect(c.reads.identity).toBe(e.code === -1 ? 6 : 2);
    }
  });
});
