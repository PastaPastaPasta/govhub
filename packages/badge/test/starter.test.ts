import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, fromHex, idToBytes, toHex } from '../src/bytes.ts';
import { blind, finalize, importIssuerKey } from '../src/client.ts';
import { EPOCH_PARAMS, epochStart } from '../src/epoch.ts';
import { buildBadgeMessage } from '../src/format.ts';
import { buildTokenRequest } from '../src/request.ts';
import {
  buildStarterMessage,
  buildStarterRequest,
  parseStarterRequest,
  prepareStarter,
  STARTER_MESSAGE_LEN,
  starterKeyUsable,
  starterRedeemEpochs,
  starterRequestEpochs,
  verifyStarterToken,
  type StarterRequest,
} from '../src/starter.ts';
import { rawSign, rnd, testKey } from './helpers.ts';

const vector = JSON.parse(readFileSync(fileURLToPath(new URL('./vectors/starter-v1.json', import.meta.url)), 'utf8')) as Record<string, string | number>;
const P = EPOCH_PARAMS.testnet;

async function token(fields = { net: 'testnet' as const, issuerId: rnd(32), epoch: 2743, pubKeyHash: rnd(20) }) {
  const { priv, key } = await testKey(2048);
  const p = prepareStarter(key, fields);
  const b = await blind(key, p.preparedMsg);
  const sig = await finalize(key, p.preparedMsg, rawSign(priv, b.blindedMsg), b.inv);
  return { key, fields, p, b, sig };
}

describe('starter token', () => {
  it('pins the v1 message layout and a finalized signature (the vector dash-faucet-cf checks too)', async () => {
    const key = await importIssuerKey(base64ToBytes(vector.spki as string));
    expect(toHex(key.keyId)).toBe(vector.keyId);
    const fields = { net: 'testnet' as const, issuerId: idToBytes(vector.issuerId as string), epoch: vector.epoch as number, pubKeyHash: fromHex(vector.pubKeyHash as string) };
    const message = buildStarterMessage({ ...fields, keyId: key.keyId });
    expect(message.length).toBe(STARTER_MESSAGE_LEN);
    expect(toHex(message)).toBe(vector.message);
    expect(new TextDecoder().decode(message.subarray(0, 17))).toBe('govhub-starter:v1');
    expect(await verifyStarterToken(key, fields, base64ToBytes(vector.msgPrefix as string), base64ToBytes(vector.sig as string))).toBe(true);
  });

  it('a token verifies only for the pubKeyHash, epoch, issuer and network it was made for', async () => {
    const { key, fields, p, sig } = await token();
    expect(await verifyStarterToken(key, fields, p.msgPrefix, sig)).toBe(true);
    for (const other of [{ pubKeyHash: rnd(20) }, { epoch: fields.epoch + 1 }, { issuerId: rnd(32) }, { net: 'mainnet' as const }]) {
      expect(await verifyStarterToken(key, { ...fields, ...other }, p.msgPrefix, sig)).toBe(false);
    }
    expect(await verifyStarterToken(key, fields, rnd(32), sig)).toBe(false);
    expect(await verifyStarterToken(key, fields, p.msgPrefix.subarray(1), sig)).toBe(false);
  });

  it('is not a badge: the domains and lengths differ, so a starter signature can never verify as an mnBadge', async () => {
    const { key, fields } = await token();
    const badge = buildBadgeMessage({ net: 'testnet', contractId: rnd(32), issuerId: fields.issuerId, keyId: key.keyId, epoch: fields.epoch, ownerId: rnd(32) });
    const starter = buildStarterMessage({ ...fields, keyId: key.keyId });
    expect(badge.length).not.toBe(starter.length);
    expect(toHex(badge.subarray(0, 12))).not.toBe(toHex(starter.subarray(0, 12)));
  });

  it('two tokens never share a prefix or a blinded message', async () => {
    const a = await token();
    const b = await token({ ...a.fields });
    expect(toHex(a.p.msgPrefix)).not.toBe(toHex(b.p.msgPrefix));
    expect(toHex(a.b.blindedMsg)).not.toBe(toHex(b.b.blindedMsg));
  });
});

describe('starter token request', () => {
  const req = (o: Partial<StarterRequest> = {}): StarterRequest => ({
    net: 'testnet', issuerId: idToBytes(vector.issuerId as string), epoch: 2743, keyId: rnd(32), kind: 'mn', subject: rnd(32), nonce: rnd(40), blindedMsgSha256: rnd(32), ...o,
  });

  it('round trips both kinds, canonical form only', () => {
    for (const kind of ['mn', 'proposal'] as const) {
      const s = buildStarterRequest(req({ kind }));
      expect(s.startsWith(`govhub-starter-req:v1|testnet|${vector.issuerId}|2743|`)).toBe(true);
      expect(buildStarterRequest(parseStarterRequest(s))).toBe(s);
    }
    const s = buildStarterRequest(req());
    for (const bad of [s.toUpperCase(), s.replace('|2743|', '|02743|'), s.replace('|mn|', '|badge|'), s + '|', s.replace('govhub-starter-req:v1', 'govhub-badge-req:v2'), 'x'.repeat(600)]) {
      expect(() => parseStarterRequest(bad)).toThrow();
    }
  });

  it('can never be read as a badge request or a claim (different domain and field count)', () => {
    const r = req();
    const badge = buildTokenRequest({ net: r.net, issuerId: r.issuerId, epoch: r.epoch, keyId: r.keyId, proTxHash: r.subject, nonce: r.nonce, blindedMsgSha256: r.blindedMsgSha256 });
    expect(() => parseStarterRequest(badge)).toThrow();
    expect(buildStarterRequest(r).startsWith('govhub-claim|')).toBe(false);
  });
});

describe('starter epochs', () => {
  it('asks for the current epoch, then the next; only the next in the last margin blocks', () => {
    const s = epochStart(P, 2742);
    expect(starterRequestEpochs(P, s)).toEqual([2742, 2743]);
    expect(starterRequestEpochs(P, s + 576 - P.boundaryMarginBlocks - 1)).toEqual([2742, 2743]);
    expect(starterRequestEpochs(P, s + 576 - P.boundaryMarginBlocks)).toEqual([2743]);
  });

  it('a current-epoch key counts only if published before the epoch began; the next epoch\'s key under the reader rules', () => {
    const s = epochStart(P, 2742);
    const h = s + 100; // inside 2742
    expect(starterKeyUsable(P, h, 2742, s - 1)).toBe(true);
    expect(starterKeyUsable(P, h, 2742, s)).toBe(false); // published at or after S(current): not used, clients ask for 2743
    expect(starterKeyUsable(P, h, 2742, s + 50)).toBe(false);
    expect(starterKeyUsable(P, h, 2743, s + 50)).toBe(true); // the next epoch may have a late key (acceptIssuerKey still applies)
    // the same key once its epoch has started is judged by the same rule, so its label depends on the height only
    expect(starterKeyUsable(P, epochStart(P, 2743) + 1, 2743, s + 50)).toBe(true);
  });

  it('the faucet redeems the previous, current and next epochs', () => {
    expect(starterRedeemEpochs(P, epochStart(P, 2742) + 5)).toEqual([2741, 2742, 2743]);
  });
});
