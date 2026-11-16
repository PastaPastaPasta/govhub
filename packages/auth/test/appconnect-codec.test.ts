import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { bytesToHex, fromBase58, hash160, hexToBytes } from '../src/bytes.ts';
import {
  buildConnectUri,
  decodeRequest,
  encodeRequest,
  fromBase64url,
  makeLoginRequest,
  openPayload,
  parseConnectUri,
  requestHash,
  RequestError,
  responseAad,
  responseKey,
  sealPayload,
  sessionKeyRequestId,
  toBase64url,
  type ConnectRequest,
} from '../src/appconnect/index.ts';
import V from './fixtures/app-connect-vectors.json' with { type: 'json' };

const I = V.inputs;
const appPriv = hexToBytes(I.appEphemeralPrivateKey);
const appPub = secp256k1.getPublicKey(appPriv, true);

/** The DIP's request vector: label Yappr, a contractGroup binding at CRITICAL, a documentType binding on DashPay profile, an ENCRYPTION binding. */
const vectorRequest = (): ConnectRequest => ({
  appEphemeralPubKey: appPub,
  appId: fromBase58(I.appId),
  label: 'Yappr',
  authBindings: [
    { kind: 'contractGroup', securityLevel: 1, id: fromBase58(I.groupId), totalBudget: 50_000_000_000n, expiresAt: I.expiresAt },
    { kind: 'documentType', securityLevel: 2, id: fromBase58(I.dashpayContractId), documentTypeName: 'profile', totalBudget: 1_000_000_000n, expiresAt: I.expiresAt },
  ],
  encBindings: [{ contractId: fromBase58(I.appId), purpose: 1 }],
  createdAt: I.createdAt,
  connectionId: hexToBytes(I.connectionId),
});

// The devnet connect URI printed in the DIP's "Request Vector" section (dashpay/dips#181 at dec23c7).
const DIP_CONNECT_URI =
  'dashpay://connect?v=2&n=d&r=AgPoPLkn6F-WrlCpXKO-Icx6N1UTmpQbFdmbAa9P7PDScPiDPHotWKuBbCSukV_iqpRnZYi0Z7oenyskwaPff9t4BVlhcHByAjICAbBZDlkmnGiFrPcdJ9386FGH4syXNsQulYEnzTW-bTjoAAAAC6Q7dAAAAAGi9760AAI6AQKiobSsb-8i6ioaaOgSNkSzV4dfa0EsGBCSgcFG57JxvAAAAAA7msoAAAABove-tAAHcHJvZmlsZQMQppsbT2ZmgUU97Dc0ZnpasgQh-IM8ei1Yq4FsJK6RX-KqlGdliLRnuh6fKyTBo99_23gBBggAAAGhKEJcAA&cb=https%3A%2F%2Fyap.pr%2Fconnect%3Fr%3Dd77dc0da9df83a47755a15c42c5d9db9d7a7fd62';
const CB = 'https://yap.pr/connect?r=d77dc0da9df83a47755a15c42c5d9db9d7a7fd62';

describe('DIP vectors', () => {
  it('reproduces the request body and its hash byte for byte', () => {
    expect(bytesToHex(appPub)).toBe(V.request.appEphemeralPubKey);
    expect(bytesToHex(encodeRequest(vectorRequest()))).toBe(V.request.bytes);
    expect(bytesToHex(requestHash(vectorRequest()))).toBe(V.request.appEphemeralPubKeyHash);
  });

  it('reproduces the dashpay://connect URI and reads it back', () => {
    expect(buildConnectUri(vectorRequest(), 'devnet', CB)).toBe(DIP_CONNECT_URI);
    const p = parseConnectUri(DIP_CONNECT_URI);
    expect(p.network).toBe('devnet');
    expect(p.callbackUrl).toBe(CB);
    expect(bytesToHex(p.body)).toBe(V.request.bytes);
    expect(bytesToHex(encodeRequest(p.request))).toBe(V.request.bytes);
  });

  it('reproduces the renew request (MODE = 1 with an IDENTITY_HINT)', () => {
    const r: ConnectRequest = { ...vectorRequest(), authBindings: [vectorRequest().authBindings[0]!], encBindings: [], identityHint: fromBase58(I.ownerId), renew: true };
    expect(bytesToHex(encodeRequest(r))).toBe(V.renewRequest.bytes);
    expect(decodeRequest(hexToBytes(V.renewRequest.bytes))).toMatchObject({ renew: true, identityHint: fromBase58(I.ownerId) });
  });

  it('reproduces the session key leaves', () => {
    expect(bytesToHex(sessionKeyRequestId(appPub, 0))).toBe('a0ad9d4647bd9296611258b8f47db92b06bdaee8782fd28e51632403d8a66a1e');
    expect(bytesToHex(sessionKeyRequestId(appPub, 1))).toBe('27a2c59bcf28894aee77c809c3c0e94201db08b66648c16fdfa689e6926b4f52');
  });

  it('reproduces the response envelope and decrypts it', () => {
    const walletPriv = hexToBytes(I.walletEphemeralPrivateKey);
    const walletPub = hexToBytes(V.response.walletEphemeralPubKey);
    const owner = fromBase58(I.ownerId);
    expect(bytesToHex(secp256k1.getPublicKey(walletPriv, true))).toBe(V.response.walletEphemeralPubKey);
    expect(bytesToHex(responseKey(walletPriv, appPub))).toBe(V.response.sessionKey);
    expect(bytesToHex(responseKey(appPriv, walletPub))).toBe(V.response.sessionKey);
    expect(bytesToHex(responseAad(appPub, owner))).toBe(V.response.aad);
    const slots = I.slotPrivateKeys.map(hexToBytes);
    const sealed = sealPayload({ appEphemeralPubKey: appPub, ownerId: owner, slots, walletEphemeralPrivateKey: walletPriv, nonce: hexToBytes(I.nonce) });
    expect(bytesToHex(sealed.encryptedPayload)).toBe(V.response.encryptedPayload);
    const opened = openPayload({ appEphemeralPrivateKey: appPriv, ownerId: owner, walletEphemeralPubKey: walletPub, encryptedPayload: hexToBytes(V.response.encryptedPayload) });
    expect(bytesToHex(Uint8Array.from(opened.flatMap((s) => [...s])))).toBe(V.response.plaintext);
    expect(opened.map((s) => bytesToHex(secp256k1.getPublicKey(s, true)))).toEqual(V.response.slotPublicKeys);
    expect(opened.map((s) => bytesToHex(hash160(secp256k1.getPublicKey(s, true))))).toEqual(V.response.slotPublicKeyHashes);
  });

  it('refuses the response under another owner, with a flipped bit, or with bad framing', () => {
    const base = { appEphemeralPrivateKey: appPriv, walletEphemeralPubKey: hexToBytes(V.response.walletEphemeralPubKey), encryptedPayload: hexToBytes(V.response.encryptedPayload) };
    expect(() => openPayload({ ...base, ownerId: fromBase58(I.appId) })).toThrow(/does not decrypt/);
    const flipped = base.encryptedPayload.slice();
    flipped[40]! ^= 1;
    expect(() => openPayload({ ...base, ownerId: fromBase58(I.ownerId), encryptedPayload: flipped })).toThrow(/does not decrypt/);
    expect(() => openPayload({ ...base, ownerId: fromBase58(I.ownerId), encryptedPayload: base.encryptedPayload.subarray(0, 123) })).toThrow(/not 28 \+ 32n/);
    expect(() => openPayload({ ...base, ownerId: fromBase58(I.ownerId), maxSlots: 2 })).toThrow(/not 28 \+ 32n/);
  });
});

describe('base64url', () => {
  it('round-trips every length without padding', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const t = toBase64url(b);
      expect(t).not.toMatch(/[=+/]/);
      expect(fromBase64url(t)).toEqual(b);
    }
    expect(toBase64url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
    expect(fromBase64url('')).toEqual(new Uint8Array(0));
  });

  it.each([
    ['AA==', 'padding'],
    ['+w', 'standard alphabet +'],
    ['/w', 'standard alphabet /'],
    ['A', 'length 1 mod 4'],
    ['AAAAA', 'length 1 mod 4'],
    ['AB', 'non-zero trailing bits (2 chars)'],
    ['AAB', 'non-zero trailing bits (3 chars)'],
    ['A A', 'a space'],
  ])('refuses %s (%s)', (text) => {
    expect(() => fromBase64url(text)).toThrow(RequestError);
  });
});

describe('request rules', () => {
  const body = () => hexToBytes(V.request.bytes);
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as RequestError).code;
    }
    return 'ok';
  };

  it('refuses another version as unsupported', () => {
    const b = body();
    b[0] = 3;
    expect(code(() => decodeRequest(b))).toBe('unsupported');
  });

  it('refuses an unknown even field as unsupported and skips an unknown odd one', () => {
    expect(code(() => decodeRequest(Uint8Array.from([...body(), 0x08, 0x01, 0x00])))).toBe('unsupported');
    expect(decodeRequest(Uint8Array.from([...body(), 0x07, 0x02, 0xaa, 0xbb, 0x07, 0x00])).label).toBe('Yappr');
  });

  it('refuses fields out of order, repeated, truncated or of the wrong length', () => {
    expect(code(() => decodeRequest(Uint8Array.from([...body(), 0x06, 0x08, 0, 0, 1, 0xa1, 0x28, 0x42, 0x5c, 0])))).toBe('invalid'); // CREATED_AT twice
    expect(code(() => decodeRequest(Uint8Array.from([...body(), 0x01, 0x20, ...new Uint8Array(32)])))).toBe('invalid'); // hint after created-at
    expect(code(() => decodeRequest(body().subarray(0, body().length - 1)))).toBe('invalid');
    const b = body();
    b[b.length - 9] = 7; // CREATED_AT length 7
    expect(code(() => decodeRequest(b))).toBe('invalid');
  });

  it('refuses a request without CREATED_AT or binding, and out-of-range times', () => {
    expect(code(() => encodeRequest({ ...vectorRequest(), authBindings: [] }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...vectorRequest(), createdAt: 0 }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...vectorRequest(), createdAt: 2 ** 53 }))).toBe('invalid');
    const noCreated = body().subarray(0, body().length - 10);
    expect(code(() => decodeRequest(noCreated))).toBe('invalid');
  });

  it('refuses labels with control or bidi characters, or over 64 bytes', () => {
    for (const label of ['a\u0007b', 'a‮b', 'a\u0085', 'x'.repeat(65), 'é'.repeat(33)]) expect(code(() => encodeRequest({ ...vectorRequest(), label }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...vectorRequest(), label: 'é'.repeat(32) }))).toBe('ok');
  });

  it('refuses bad bindings', () => {
    const r = vectorRequest();
    const b0 = r.authBindings[0]!;
    expect(code(() => encodeRequest({ ...r, authBindings: [{ ...b0, securityLevel: 0 }] }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...r, authBindings: [{ ...b0, totalBudget: undefined }] }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...r, authBindings: [b0, { ...b0 }] }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...r, authBindings: [{ ...r.authBindings[1]!, documentTypeName: 'bad name' }] }))).toBe('invalid');
    expect(code(() => encodeRequest({ ...r, encBindings: [{ contractId: r.appId, purpose: 3 }] }))).toBe('invalid');
    // HIGH or CRITICAL on any kind
    expect(code(() => encodeRequest({ ...r, authBindings: [{ kind: 'singleContract', securityLevel: 1, id: r.appId }] }))).toBe('ok');
  });

  it('refuses malformed URIs', () => {
    const ok = buildConnectUri(vectorRequest(), 'mainnet');
    expect(ok.startsWith('dashpay://connect?v=2&n=m&r=')).toBe(true);
    expect(parseConnectUri(ok.replace('dashpay://connect', 'DASHPAY://CONNECT')).network).toBe('mainnet');
    expect(code(() => parseConnectUri(ok.replace('v=2', 'v=3')))).toBe('unsupported');
    expect(code(() => parseConnectUri(`${ok}&n=t`))).toBe('invalid');
    expect(code(() => parseConnectUri(ok.replace('n=m', 'n=x')))).toBe('invalid');
    expect(code(() => parseConnectUri(ok.replace('dashpay://connect', 'dashpay://sign')))).toBe('invalid');
    expect(code(() => parseConnectUri(ok.replace('dashpay:', 'dash-key:')))).toBe('invalid');
    expect(code(() => parseConnectUri(`${ok}#x`))).toBe('invalid');
    expect(code(() => parseConnectUri(`${ok}&cb=${encodeURIComponent('http://example.org/')}`))).toBe('invalid');
    expect(code(() => parseConnectUri(`${ok}&cb=${encodeURIComponent('https://u:p@example.org/')}`))).toBe('invalid');
    expect(code(() => buildConnectUri(vectorRequest(), 'mainnet', `https://example.org/${'a'.repeat(512)}`))).toBe('invalid');
    expect(parseConnectUri(`${ok}&later=1`).network).toBe('mainnet');
  });
});

describe("govhub's login request", () => {
  const forum = '4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3';
  it('asks for one HIGH key bound to the forum contract, with a budget and an expiry, on mainnet', () => {
    const now = 1_794_850_000_000;
    const cid = new Uint8Array(16).fill(9);
    const l = makeLoginRequest({ contractId: forum, network: 'mainnet', connectionId: cid, now });
    expect(l.uri).toMatch(/^dashpay:\/\/connect\?v=2&n=m&r=[A-Za-z0-9_-]+$/);
    const { request } = parseConnectUri(l.uri);
    expect(request.label).toBe('govhub');
    expect(request.appId).toEqual(fromBase58(forum));
    expect(request.authBindings).toEqual([{ kind: 'singleContract', securityLevel: 2, id: fromBase58(forum), totalBudget: 10_000_000_000n, expiresAt: now + 90 * 86_400_000 }]);
    expect(request.encBindings).toEqual([]);
    expect(request.identityHint).toBeUndefined();
    expect(request.connectionId).toEqual(cid);
    expect(request.createdAt).toBe(now);
    expect(request.appEphemeralPubKey).toEqual(secp256k1.getPublicKey(l.appEphemeralPrivateKey, true));
    l.end();
    expect(l.appEphemeralPrivateKey.every((b) => b === 0)).toBe(true);
  });

  it('makes a fresh ephemeral key every time', () => {
    const a = makeLoginRequest({ contractId: forum, network: 'mainnet', connectionId: new Uint8Array(16), now: 1 });
    const b = makeLoginRequest({ contractId: forum, network: 'mainnet', connectionId: new Uint8Array(16), now: 1 });
    expect(a.request.appEphemeralPubKey).not.toEqual(b.request.appEphemeralPubKey);
  });
});
