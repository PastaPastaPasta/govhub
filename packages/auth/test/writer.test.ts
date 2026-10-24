// The one document writer (evo.ts writeDocument) against a scripted SDK: PV13 ids and the duplicate rule, PV14 creates sent once,
// lag retries, deletes never reported done after refusals, integers as bigint, and the session key copied and refused when wiped.
import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, identifierBytes, randomBytes, sha256d, toBase58 } from '../src/bytes.ts';
import { createEvoPlatform } from '../src/evo.ts';
import type { SigningKey } from '../src/platform.ts';

const owner = toBase58(randomBytes(32));
const contract = toBase58(randomBytes(32));
const key: SigningKey = { id: 2, purpose: 0, securityLevel: 2, type: 0, privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };

function fake(o: { version: number; fail?: (op: string, attempt: number) => unknown; stored?: boolean }) {
  const calls: Array<{ op: string; doc?: Record<string, unknown> }> = [];
  const attempts: Record<string, number> = {};
  const go = (op: string, doc?: Record<string, unknown>) => {
    calls.push({ op, doc });
    const n = (attempts[op] = (attempts[op] ?? -1) + 1);
    const err = o.fail?.(op, n);
    if (err) throw err;
  };
  class Obj {
    free() {}
  }
  const evo = {
    IdentitySigner: class extends Obj {
      addKey() {}
    },
    PrivateKey: { fromBytes: () => new Obj() },
    Document: { fromObject: (doc: Record<string, unknown>) => doc },
    PlatformVersion: { latest: () => 'latest' },
  };
  const sdk = {
    version: () => o.version,
    identities: { fetchWithProof: async () => ({ data: { getPublicKeyById: () => ({ id: 2 }) } }) },
    documents: {
      create: async ({ document }: { document: Record<string, unknown> }) => {
        go('create', document);
        return { id: { toString: () => toBase58(document.$id as Uint8Array) } };
      },
      replace: async ({ document }: { document: Record<string, unknown> }) => go('replace', document),
      delete: async () => go('delete'),
      getWithProof: async () => ({ data: o.stored ? {} : undefined }),
    },
  };
  return { port: createEvoPlatform(evo as never, sdk as never, 'testnet'), calls };
}
const err = (message: string) => Object.assign(new Error(message), { code: 0 });

describe('writeDocument', () => {
  it('PV13 create: the id is sha256d(contract || owner || type || entropy); integers go as bigint', async () => {
    const { port, calls } = fake({ version: 13 });
    const r = await port.writeDocument({ ownerId: owner, key, op: { action: 'create', contractId: contract, type: 'comment', data: { fmt: 1, body: 'x' } } });
    const doc = calls[0]!.doc!;
    const expected = sha256d(concatBytes(identifierBytes(contract), identifierBytes(owner), new TextEncoder().encode('comment'), doc.$entropy as Uint8Array));
    expect(bytesToHex(doc.$id as Uint8Array)).toBe(bytesToHex(expected));
    expect(r.id).toBe(toBase58(expected));
    expect(doc.fmt).toBe(1n);
  });

  it('PV13: a FIRST attempt refused as a duplicate is a refusal; a retry finding its own id stored is success', async () => {
    const first = fake({ version: 13, fail: (op, n) => op === 'create' && n === 0 && err('document already exists'), stored: true });
    await expect(first.port.writeDocument({ ownerId: owner, key, op: { action: 'create', contractId: contract, type: 'reaction', data: {} } })).rejects.toThrow(/already exists/);
    const retried = fake({ version: 13, fail: (op, n) => op === 'create' && (n === 0 ? err('nonce too old [code 40101]') : err('document already exists')), stored: true });
    const r = await retried.port.writeDocument({ ownerId: owner, key, op: { action: 'create', contractId: contract, type: 'reaction', data: {} } });
    expect(retried.calls).toHaveLength(2);
    expect(r.revision).toBe(1);
    const notStored = fake({ version: 13, fail: (op, n) => op === 'create' && (n === 0 ? err('nonce too old') : err('document already exists')), stored: false });
    await expect(notStored.port.writeDocument({ ownerId: owner, key, op: { action: 'create', contractId: contract, type: 'reaction', data: {} } })).rejects.toThrow(/already exists/);
  });

  it('PV14 create is sent exactly once, even on a lagging-node error', async () => {
    const { port, calls } = fake({ version: 14, fail: () => err('nonce too old [code 40101]') });
    await expect(port.writeDocument({ ownerId: owner, key, op: { action: 'create', contractId: contract, type: 'comment', data: {} } })).rejects.toThrow(/nonce/);
    expect(calls).toHaveLength(1);
    expect(bytesToHex(calls[0]!.doc!.$id as Uint8Array)).toBe('00'.repeat(32));
  });

  it('a delete refused by lagging nodes every time is an error, never success', async () => {
    const { port, calls } = fake({ version: 14, fail: (op) => op === 'delete' && err('abc document not found [code 40101]') });
    await expect(port.writeDocument({ ownerId: owner, key, op: { action: 'delete', contractId: contract, type: 'vault', id: owner } })).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(5);
  }, 40_000);

  it('replace sends revision + 1 and retries a lagging node', async () => {
    const { port, calls } = fake({ version: 14, fail: (op, n) => op === 'replace' && n === 0 && err('document not found [code 40101]') });
    const r = await port.writeDocument({ ownerId: owner, key, op: { action: 'replace', contractId: contract, type: 'profile', id: owner, revision: 3, data: { displayName: 'a' } } });
    expect(r.revision).toBe(4);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.doc!.$revision).toBe(4n);
  });

  it('refuses a wiped (all-zero) key and never touches the caller key', async () => {
    const { port } = fake({ version: 14 });
    await expect(port.writeDocument({ ownerId: owner, key: { ...key, privateKey: new Uint8Array(32) }, op: { action: 'delete', contractId: contract, type: 'vault', id: owner } })).rejects.toThrow(/ended/);
    const k = { ...key, privateKey: key.privateKey.slice() };
    await port.writeDocument({ ownerId: owner, key: k, op: { action: 'delete', contractId: contract, type: 'vault', id: owner } });
    expect(bytesToHex(k.privateKey)).toBe(bytesToHex(key.privateKey));
  });
});
