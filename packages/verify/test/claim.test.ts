import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import {
  buildProposalDataHex,
  bytesToHex,
  checkClaimSignature,
  claimMessage,
  decodeAddress,
  governanceObjectHash,
  inputKeyIds,
  hexToBytes,
  p2pkhAddress,
  hash160,
  signMessageRaw,
  urlClaimIdentity,
  verifyMessage,
  verifyClaims,
  type ClaimDoc,
  type ClaimInput,
} from '../src/index.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { fixture } from './helpers.ts';

interface Fx {
  identities: { I1: string; I2: string };
  addresses: { A: string; B: string; P2SH: string };
  proposals: Array<{ label: string; parentHash: string; revision: number; time: number; dataHex: string; govHash: string; collateralTxid: string; rawCollateralTx: string; collateralInputs: Array<{ address: string }> }>;
  signatures: Array<{ label: string; proposal: string; method: number; address: string; identity: 'I1' | 'I2'; net: string; message: string; sigBase64: string; coreVerify: boolean; negative: { address: string; message: string; coreVerify: boolean } }>;
  errors: Array<{ label: string; coreError: string }>;
}
const fx = fixture<Fx>('claims.regtest.json');
const P = (label: string) => fx.proposals.find((p) => p.label === label)!;
const S = (label: string) => fx.signatures.find((s) => s.label === label)!;
const PORTALS = ['gov.dashhq.org'];
const TEAM = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';

let n = 0;
const claim = (ownerId: string, method: number, sigB64: string, createdAt = 1000 + n): ClaimDoc => ({ id: `doc${++n}`, ownerId, method, sig: base64.decode(sigB64), createdAt });
function input(label: string, over: Partial<ClaimInput> = {}): ClaimInput {
  const p = P(label);
  return { network: 'regtest', govHash: p.govHash, parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex, claims: [], attestations: [], attestors: [TEAM], portals: PORTALS, ...over };
}
const keysOf = (label: string) => inputKeyIds(hexToBytes(P(label).rawCollateralTx));

describe('fixture: real Dash Core regtest signmessage vectors', () => {
  it('Core produced every vector it was asked for and verified each against its intended address only', () => {
    expect(fx.proposals.map((p) => p.label)).toEqual(['url-embedded', 'pay-p2pkh', 'pay-p2sh', 'url-wrong-name']);
    expect(fx.signatures.length).toBe(6);
    for (const s of fx.signatures) {
      expect(s.coreVerify).toBe(true);
      expect(s.negative.coreVerify).toBe(false);
    }
    expect(fx.errors[0]!.coreError).toContain('Address does not refer to key');
  });

  it('our gov hash equals Core objectHash for every prepared proposal', () => {
    for (const p of fx.proposals) expect(governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).display).toBe(p.govHash);
  });

  it('claimMessage builds exactly the strings Core signed', () => {
    const s = S('pay-p2pkh-valid');
    expect(claimMessage('regtest', P('pay-p2pkh').govHash, fx.identities.I1)).toBe(s.message);
    expect(claimMessage('regtest', P('pay-p2pkh').govHash.toUpperCase(), fx.identities.I1)).toBe(s.message);
  });

  it('agrees with Core verifymessage on every positive and negative pairing', () => {
    for (const s of fx.signatures) {
      expect(verifyMessage(s.address, s.sigBase64, s.message, 'regtest')).toBe(s.coreVerify);
      expect(verifyMessage(s.negative.address, s.sigBase64, s.negative.message, 'regtest')).toBe(s.negative.coreVerify);
    }
    // The UI pre-check rebuilds the message from its parts.
    const s = S('pay-p2pkh-valid');
    expect(checkClaimSignature(s.address, s.sigBase64, 'regtest', P('pay-p2pkh').govHash, fx.identities.I1)).toBe(true);
    expect(checkClaimSignature(s.address, s.sigBase64, 'regtest', P('pay-p2pkh').govHash, fx.identities.I2)).toBe(false);
  });
});

describe('method 2: payment-address signature', () => {
  const { I1, I2 } = fx.identities;
  it('a Core signature by the payment address claims the proposal for the claim document owner', () => {
    const v = verifyClaims(input('pay-p2pkh', { claims: [claim(I1, 2, S('pay-p2pkh-valid').sigBase64)] }));
    expect(v.dataCommitted).toBe(true);
    expect(v.paymentAddress).toBe(fx.addresses.A);
    expect(v.owner).toMatchObject({ identityId: I1, method: 2 });
    expect(v.rejected).toEqual([]);
  });

  it('the same signature copied into another identity\'s claim document does not verify', () => {
    const v = verifyClaims(input('pay-p2pkh', { claims: [claim(I2, 2, S('pay-p2pkh-valid').sigBase64)] }));
    expect(v.owner).toBeNull();
    expect(v.rejected[0]!.reason).toMatch(/does not verify/);
  });

  it('a signature by another wallet address is rejected', () => {
    const v = verifyClaims(input('pay-p2pkh', { claims: [claim(I1, 2, S('pay-p2pkh-wrong-signer').sigBase64)] }));
    expect(v.owner).toBeNull();
  });

  it('the network is bound: a signature over "mainnet" does not claim the regtest proposal', () => {
    expect(verifyClaims(input('pay-p2pkh', { claims: [claim(I1, 2, S('net-mainnet').sigBase64)] })).owner).toBeNull();
  });

  it('byte order is bound: a signature over the raw-order hash is rejected', () => {
    expect(verifyClaims(input('pay-p2pkh', { claims: [claim(I1, 2, S('govhash-raw-order').sigBase64)] })).owner).toBeNull();
  });

  it('a signature for one proposal does not claim another proposal paying the same address', () => {
    expect(P('url-embedded').dataHex).toContain(Buffer.from(fx.addresses.A).toString('hex'));
    const v = verifyClaims(input('url-embedded', { portals: [], claims: [claim(I1, 2, S('pay-p2pkh-valid').sigBase64)] }));
    expect(v.owner).toBeNull();
  });

  it('a P2SH payout cannot sign (Core: "Address does not refer to key"); the verifier says why', () => {
    const v = verifyClaims(input('pay-p2sh', { claims: [claim(I1, 2, S('pay-p2pkh-valid').sigBase64)] }));
    expect(v.owner).toBeNull();
    expect(v.rejected[0]!.reason).toMatch(/not a P2PKH address/);
  });

  it('a claim on a different network than the payment address is rejected (mainnet verifier, regtest address)', () => {
    const v = verifyClaims(input('pay-p2pkh', { network: 'mainnet', claims: [claim(I1, 2, S('net-mainnet').sigBase64)] }));
    expect(v.owner).toBeNull();
  });
});

describe('method 3: collateral input key', () => {
  const { I1, I2 } = fx.identities;
  it('inputKeyIds finds the key that spent the collateral input', () => {
    const want = bytesToHex(decodeAddress(P('pay-p2pkh').collateralInputs[0]!.address, 'regtest')!.hash160);
    expect(keysOf('pay-p2pkh')).toEqual([want]);
  });

  it('a Core signature by the collateral input address claims the proposal', () => {
    const v = verifyClaims(input('pay-p2pkh', { collateralInputKeys: keysOf('pay-p2pkh'), claims: [claim(I2, 3, S('collateral-pay-p2pkh').sigBase64)] }));
    expect(v.owner).toMatchObject({ identityId: I2, method: 3 });
  });

  it('is unavailable until the caller has verified the collateral transaction', () => {
    const v = verifyClaims(input('pay-p2pkh', { claims: [claim(I2, 3, S('collateral-pay-p2pkh').sigBase64)] }));
    expect(v.owner).toBeNull();
    expect(v.rejected[0]!.reason).toMatch(/not been verified/);
  });

  it('the declared method is the one checked: an input-key signature filed as method 2 fails', () => {
    const v = verifyClaims(input('pay-p2pkh', { collateralInputKeys: keysOf('pay-p2pkh'), claims: [claim(I2, 2, S('collateral-pay-p2pkh').sigBase64)] }));
    expect(v.owner).toBeNull();
  });

  it('a payment-address signature filed as method 3 fails (A did not spend a collateral input)', () => {
    const v = verifyClaims(input('pay-p2pkh', { collateralInputKeys: keysOf('pay-p2pkh'), claims: [claim(I1, 3, S('pay-p2pkh-valid').sigBase64)] }));
    expect(v.owner).toBeNull();
    expect(v.rejected[0]!.reason).toMatch(/did not sign an input/);
  });

  it('ignores inputs that are not <sig> <pubkey>', () => {
    // A coinbase-like tx: one input with an arbitrary script, one output.
    const tx = hexToBytes('0100000001' + '00'.repeat(32) + 'ffffffff' + '0451020304' + 'ffffffff' + '01' + '0000000000000000' + '00' + '00000000');
    expect(inputKeyIds(tx)).toEqual([]);
  });
});

describe('method 1: identity in the hashed URL', () => {
  const { I1, I2 } = fx.identities;
  it('names the owner, and outranks a valid method-3 claim by someone else', () => {
    const v = verifyClaims(input('url-embedded', { collateralInputKeys: keysOf('url-embedded'), claims: [claim(I2, 3, S('collateral-url-embedded').sigBase64)] }));
    expect(v.owner).toMatchObject({ identityId: I1, method: 1 });
    expect(v.valid.map((c) => [c.identityId, c.method])).toEqual([
      [I1, 1],
      [I2, 3],
    ]);
  });

  it('needs the name segment to be the proposal name', () => {
    expect(verifyClaims(input('url-wrong-name')).owner).toBeNull();
  });

  it('needs a configured portal host', () => {
    expect(verifyClaims(input('url-embedded', { portals: ['example.org'] })).owner).toBeNull();
  });

  it('urlClaimIdentity is strict', () => {
    const id = I1;
    expect(urlClaimIdentity(`https://gov.dashhq.org/p/${id}/claim-url`, 'claim-url', PORTALS)).toBe(id);
    expect(urlClaimIdentity(`https://GOV.dashhq.org/p/${id}/CLAIM-url`, 'claim-url', PORTALS)).toBe(id);
    for (const bad of [
      `http://gov.dashhq.org/p/${id}/claim-url`,
      `https://gov.dashhq.org/p/${id}/claim-url/`,
      `https://gov.dashhq.org/p/${id}/claim-url?x=1`,
      `https://gov.dashhq.org/p/${id}/claim-url#a`,
      `https://u:p@gov.dashhq.org/p/${id}/claim-url`,
      `https://gov.dashhq.org.evil.org/p/${id}/claim-url`,
      `https://gov.dashhq.org:8443/p/${id}/claim-url`,
      `https://gov.dashhq.org/x/${id}/claim-url`,
      `https://gov.dashhq.org/p/${id}1/claim-url`,
      `https://gov.dashhq.org/p/abc/claim-url`,
      `https://gov.dashhq.org/p/0${id.slice(1)}/claim-url`,
      'not a url',
    ]) expect(urlClaimIdentity(bad, 'claim-url', PORTALS)).toBeNull();
  });
});

describe('method 4 and the data commitment', () => {
  const { I1, I2 } = fx.identities;
  it('an attestation by the hosting team claims a P2SH proposal; one by anyone else is rejected', () => {
    const v = verifyClaims(input('pay-p2sh', { attestations: [{ id: 'a1', ownerId: TEAM, identityId: I2, note: 'multisig, verified by email' }, { id: 'a2', ownerId: I1, identityId: I1 }] }));
    expect(v.owner).toMatchObject({ identityId: I2, method: 4 });
    expect(v.rejected).toEqual([expect.objectContaining({ docId: 'a2', reason: expect.stringMatching(/hosting team/) })]);
  });

  it('methods 2 and 3 outrank an attestation', () => {
    const v = verifyClaims(input('pay-p2pkh', { claims: [claim(I1, 2, S('pay-p2pkh-valid').sigBase64)], attestations: [{ id: 'a1', ownerId: TEAM, identityId: I2 }] }));
    expect(v.owner).toMatchObject({ identityId: I1, method: 2 });
  });

  it('data that does not hash to the govHash disables methods 1-3 (a lying publisher cannot swap the URL or address)', () => {
    const p = P('url-embedded');
    const forged = Buffer.from(Buffer.from(p.dataHex, 'hex').toString().replace(fx.identities.I1, fx.identities.I2)).toString('hex');
    const v = verifyClaims(input('url-embedded', { dataHex: forged, claims: [claim(I1, 2, S('pay-p2pkh-valid').sigBase64)], attestations: [{ id: 'a1', ownerId: TEAM, identityId: I1 }] }));
    expect(v.dataCommitted).toBe(false);
    expect(v.paymentAddress).toBeNull();
    expect(v.owner).toMatchObject({ method: 4 });
    expect(v.rejected[0]!.reason).toMatch(/does not match its hash/);
  });
});

describe('ranking within a method', () => {
  it('the earliest valid claim wins; malformed or unknown-method claims are listed as rejected', () => {
    const priv = hexToBytes('42'.repeat(32));
    const addr = p2pkhAddress(hash160(secp256k1.getPublicKey(priv, true)), 'mainnet');
    const fields = { type: 1, name: 'rank-test', paymentAddress: addr, paymentAmount: 5, startEpoch: 1_800_000_000, endEpoch: 1_810_000_000, url: 'https://example.org/r' };
    const dataHex = buildProposalDataHex(fields);
    const g = governanceObjectHash({ parentHash: '0', revision: 1, time: 1_799_000_000, dataHex }).display;
    const ida = fx.identities.I1;
    const idb = fx.identities.I2;
    const sig = (id: string) => base64.encode(signMessageRaw(priv, claimMessage('mainnet', g, id)));
    const v = verifyClaims({
      network: 'mainnet',
      govHash: g,
      parentHash: '0'.repeat(64),
      revision: 1,
      time: 1_799_000_000,
      dataHex,
      claims: [claim(idb, 2, sig(idb), 2000), claim(ida, 2, sig(ida), 1000), { id: 'x', ownerId: ida, method: 9, sig: new Uint8Array(65), createdAt: 1 }, { id: 'y', ownerId: ida, method: 2, sig: new Uint8Array(64), createdAt: 1 }],
      attestations: [],
      attestors: [],
      portals: PORTALS,
    });
    expect(v.owner).toMatchObject({ identityId: ida, method: 2, createdAt: 1000 });
    // y (a malformed earlier try by the same identity) does not lock it out; the later valid claim by idb is not even checked.
    expect(v.valid).toHaveLength(1);
    expect(v.rejected.map((r) => [r.docId, r.reason.slice(0, 11)]).sort()).toEqual([
      ['doc' + (n - 1), 'not checked'],
      ['x', 'unknown cla'],
      ['y', 'signature i'],
    ]);
  });

  it('claim spam is bounded: per-identity tries and a total signature budget, skipped claims reported', () => {

    const junk = (owner: string, i: number): ClaimDoc => ({ id: `j${owner.slice(0, 3)}${i}`, ownerId: owner, method: 2, sig: new Uint8Array(65).fill(i % 250), createdAt: i });
    const owners = Array.from({ length: 30 }, (_, i) => fx.identities[i % 2 ? 'I1' : 'I2'].slice(0, 40) + String(i).padStart(4, 'x'));
    const claims = [...Array.from({ length: 10 }, (_, i) => junk(fx.identities.I1, i)), ...owners.flatMap((o, i) => [junk(o, 100 + i), junk(o, 200 + i)]), claim(fx.identities.I1, 2, S('pay-p2pkh-valid').sigBase64, 5000)];
    const t = performance.now();
    const v = verifyClaims(input('pay-p2pkh', { claims }));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(v.rejected.filter((r) => r.reason.startsWith('not checked: more than 3 claims by this identity'))).toHaveLength(8); // 7 junk + the real one, all by I1
    expect(v.rejected.filter((r) => r.reason.startsWith('not checked: more than 50 claims'))).not.toHaveLength(0);
    expect(v.owner).toBeNull(); // the real claim came after the budget ran out: reported, not trusted
    expect(v.rejected.at(-1)).toMatchObject({ ownerId: fx.identities.I1, reason: expect.stringContaining('more than 3') });
  });
});
