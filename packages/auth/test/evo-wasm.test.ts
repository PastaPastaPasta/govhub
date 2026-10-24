// The SDK behaviour the writer (evo.ts) builds on, pinned against the real evo-sdk 5.0.0-rc.8 WASM, offline: the create id is known
// before the broadcast (PV13 sha256d(contract || owner || type || entropy), PV14 also the nonce), a replace transition carries the
// document's revision + 1, the batch carries the nonce, and a signed transition is stable (re-sending it re-sends the same bytes).
import { beforeAll, describe, expect, it } from 'vitest';
import * as evo from '@dashevo/evo-sdk';
import { concatBytes, sha256d, toBase58 } from '../src/bytes.ts';
import { publicKeyOf } from '../src/keys.ts';

const w = evo as unknown as Record<string, any>;
const owner = new Uint8Array(32).fill(7);
const contract = new Uint8Array(32).fill(9);
const entropy = new Uint8Array(32).fill(3);
const doc = (revision = 1n) =>
  w.Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32), $ownerId: owner, $dataContractId: contract, $type: 'comment', $revision: revision, $entropy: entropy, body: 'x', fmt: 1n }, w.PlatformVersion.latest());

beforeAll(async () => {
  await (evo as { ensureInitialized?: () => Promise<void> }).ensureInitialized?.();
});

describe('evo-sdk rc.8 transitions', () => {
  it('PV13 create id = sha256d(contract || owner || type || entropy), whatever the nonce', () => {
    const want = toBase58(sha256d(concatBytes(contract, owner, new TextEncoder().encode('comment'), entropy)));
    for (const nonce of [1n, 9n]) expect(new w.DocumentCreateTransition({ document: doc(), identityContractNonce: nonce, platformVersion: 13 }).base.id.toString()).toBe(want);
  });

  it('PV14 create id commits to the nonce (Document.generateId with identityContractNonce)', () => {
    const a = new w.DocumentCreateTransition({ document: doc(), identityContractNonce: 5n, platformVersion: 14 }).base.id.toString();
    const b = new w.DocumentCreateTransition({ document: doc(), identityContractNonce: 6n, platformVersion: 14 }).base.id.toString();
    expect(a).not.toBe(b);
    expect(a).toBe(toBase58(w.Document.generateId('comment', owner, contract, entropy, 5n, 14)));
  });

  it('replace carries revision + 1; the batch carries the nonce; a signed transition re-serializes identically', () => {
    expect(new w.DocumentReplaceTransition({ document: doc(3n), identityContractNonce: 2n }).revision).toBe(4n);
    const t = new w.DocumentCreateTransition({ document: doc(), identityContractNonce: 5n, platformVersion: 14 });
    const st = w.BatchTransition.fromBatchedTransitions([new w.BatchedTransition(t.toDocumentTransition())], owner, 0).toStateTransition();
    expect(st.identityContractNonce).toBe(5n);
    const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const ipk = new w.IdentityPublicKey({ keyId: 2, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', isReadOnly: false, data: publicKeyOf(priv) });
    const bytes = st.sign(w.PrivateKey.fromBytes(priv, 'testnet'), ipk);
    expect(st.signaturePublicKeyId).toBe(2);
    expect(w.StateTransition.fromBytes(bytes).hash(false)).toBe(st.hash(false));
  });
});
