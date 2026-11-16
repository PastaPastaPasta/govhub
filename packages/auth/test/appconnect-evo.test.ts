// The App Connect port's reading of evo-sdk rc.8 values, pinned against the real WASM types offline: key bounds, budgets and expiry
// survive the JSON form chainKeyOf reads, and a contract-bound session key signs a batch like any other key.
import { beforeAll, describe, expect, it } from 'vitest';
import * as evo from '@dashevo/evo-sdk';
import { hash160, toBase58, toBase64 } from '../src/bytes.ts';
import { publicKeyOf } from '../src/keys.ts';
import { chainKeyOf, createEvoAppConnectPort, APP_CONNECT_CONTRACT_ID } from '../src/appconnect/index.ts';

const w = evo as unknown as Record<string, any>;
const FORUM = new Uint8Array(32).fill(9);
const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pub = publicKeyOf(priv);

beforeAll(async () => {
  await (evo as { ensureInitialized?: () => Promise<void> }).ensureInitialized?.();
});

const ipk = (o: Record<string, unknown>) =>
  new w.IdentityPublicKey({ keyId: 9, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', isReadOnly: false, data: pub, ...o });

describe('chainKeyOf (evo-sdk rc.8 IdentityPublicKey)', () => {
  it('reads a session key: bounds, budget and expiry', () => {
    const k = chainKeyOf(ipk({ contractBounds: w.ContractBounds.SingleContract(FORUM), totalBudget: 10_000_000_000n, expiresAt: 1_800_000_000_000n }));
    expect(k).toEqual({
      id: 9,
      type: 0,
      purpose: 0,
      securityLevel: 2,
      data: pub,
      disabled: false,
      bounds: { kind: 'singleContract', contractId: toBase58(FORUM) },
      totalBudget: 10_000_000_000n,
      expiresAt: 1_800_000_000_000,
    });
  });

  it('reads documentType and contractGroup bounds, HASH160 data and a disabled key', () => {
    expect(chainKeyOf(ipk({ contractBounds: w.ContractBounds.SingleContractDocumentType(FORUM, 'profile') }))!.bounds).toEqual({ kind: 'documentType', contractId: toBase58(FORUM), documentTypeName: 'profile' });
    expect(chainKeyOf(ipk({ contractBounds: w.ContractBounds.ContractGroup(FORUM) }))!.bounds).toEqual({ kind: 'contractGroup', groupId: toBase58(FORUM) });
    const h = chainKeyOf(ipk({ keyType: 'ecdsa_hash160', data: hash160(pub) }))!;
    expect(h).toMatchObject({ type: 2, data: hash160(pub) });
    expect(h.bounds).toBeUndefined();
    expect(h.totalBudget).toBeUndefined();
    expect(chainKeyOf(ipk({ disabledAt: 5 }))!.disabled).toBe(true);
  });

  it('signs a batch with a contract-bound, budgeted key', () => {
    const doc = w.Document.fromObject(
      { $formatVersion: '0', $id: new Uint8Array(32), $ownerId: new Uint8Array(32).fill(7), $dataContractId: FORUM, $type: 'comment', $revision: 1n, $entropy: new Uint8Array(32).fill(3), body: 'x', fmt: 1n },
      w.PlatformVersion.latest(),
    );
    const t = new w.DocumentCreateTransition({ document: doc, identityContractNonce: 5n, platformVersion: 14 });
    const st = w.BatchTransition.fromBatchedTransitions([new w.BatchedTransition(t.toDocumentTransition())], new Uint8Array(32).fill(7), 0).toStateTransition();
    st.sign(w.PrivateKey.fromBytes(priv, 'mainnet'), ipk({ contractBounds: w.ContractBounds.SingleContract(FORUM), totalBudget: 1n, expiresAt: 1n }));
    expect(st.signaturePublicKeyId).toBe(9);
  });
});

describe('createEvoAppConnectPort', () => {
  it('queries loginKeyResponse by request hash, owner order, and reads the entries', async () => {
    const calls: unknown[] = [];
    const doc = (j: Record<string, unknown>) => ({ toJSON: () => j });
    const owner = toBase58(new Uint8Array(32).fill(4));
    const sdk = {
      documents: {
        async queryWithProof(q: unknown) {
          calls.push(q);
          return {
            data: new Map<string, unknown>([
              ['a', doc({ $ownerId: owner, walletEphemeralPubKey: toBase64(new Uint8Array(33).fill(2)), encryptedPayload: toBase64(new Uint8Array(60).fill(1)) })],
              ['b', doc({ $ownerId: owner, walletEphemeralPubKey: toBase64(new Uint8Array(32)), encryptedPayload: toBase64(new Uint8Array(60)) })],
              ['c', undefined],
            ]),
          };
        },
      },
    };
    const port = createEvoAppConnectPort(sdk as never);
    const hash = new Uint8Array(20).fill(5);
    const got = await port.responses(hash, { startAfter: 'X', limit: 10 });
    expect(got).toEqual([{ ownerId: owner, walletEphemeralPubKey: new Uint8Array(33).fill(2), encryptedPayload: new Uint8Array(60).fill(1) }]);
    await port.responses(hash, { hint: owner, startAfter: 'X', limit: 10 });
    expect(calls).toEqual([
      { dataContractId: APP_CONNECT_CONTRACT_ID, documentTypeName: 'loginKeyResponse', where: [['appEphemeralPubKeyHash', '==', toBase64(hash)], ['$ownerId', '>', 'X']], orderBy: [['$ownerId', 'asc']], limit: 10 },
      { dataContractId: APP_CONNECT_CONTRACT_ID, documentTypeName: 'loginKeyResponse', where: [['appEphemeralPubKeyHash', '==', toBase64(hash)], ['$ownerId', '==', owner]], orderBy: [['$ownerId', 'asc']], limit: 10 },
    ]);
  });

  it('reads identity keys with the proof block time, and remaining budgets', async () => {
    const sdk = {
      identities: {
        fetchWithProof: async () => ({ data: { publicKeys: [ipk({ contractBounds: w.ContractBounds.SingleContract(FORUM), totalBudget: 5n, expiresAt: 6n })] }, metadata: { timeMs: 1_794_851_416_351n } }),
        keysRemainingBudgetsWithProof: async () => ({ data: new Map<number, bigint | null>([[9, 4n], [10, null]]) }),
      },
    };
    const port = createEvoAppConnectPort(sdk as never);
    const r = await port.identityKeys('x');
    expect(r!.blockTimeMs).toBe(1_794_851_416_351);
    expect(r!.keys[0]).toMatchObject({ id: 9, totalBudget: 5n, expiresAt: 6 });
    expect(await port.remainingBudgets('x', [9, 10])).toEqual(new Map([[9, 4n]]));
  });
});
