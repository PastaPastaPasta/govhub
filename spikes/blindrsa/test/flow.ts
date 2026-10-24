import { toHex } from '../src/bytes.js';
import {
  bindIssuerKey,
  blind,
  finalize,
  importIssuerKey,
  prepareBadge,
  verifyBadge,
  type BoundIssuerKey,
  type IssuerKey,
} from '../src/client.js';
import type { BadgeFields } from '../src/format.js';
import { BlindIssuer } from '../src/issuer.js';
import { cachedIssuerKey, rnd } from './helpers.js';

export type BadgeContext = Omit<BadgeFields, 'keyId'>;

export const bind = (key: IssuerKey, c: Omit<BadgeContext, 'ownerId'>): BoundIssuerKey =>
  bindIssuerKey(key, { net: c.net, contractId: c.contractId, issuerId: c.issuerId, epoch: c.epoch });

export function randomCtx(epoch?: number): BadgeContext {
  return {
    net: 1 + (rnd(1)[0]! % 4),
    contractId: rnd(32),
    issuerId: rnd(32),
    epoch: epoch ?? new DataView(rnd(4).buffer).getUint32(0),
    ownerId: rnd(32),
  };
}

export async function setup(bits: 2048 | 3072) {
  const kp = cachedIssuerKey(bits);
  const key = await importIssuerKey(kp.spki);
  const issuer = new BlindIssuer(kp.privateKey);
  return { kp, key, issuer };
}

export interface IssuedBadge {
  ctx: BadgeContext;
  msgPrefix: Uint8Array;
  sig: Uint8Array;
  preparedMsg: Uint8Array;
}

/** Full client -> issuer -> client round trip. */
export async function issueBadge(key: IssuerKey, issuer: BlindIssuer, ctx: BadgeContext): Promise<IssuedBadge> {
  const { msgPrefix, preparedMsg } = prepareBadge(bind(key, ctx), ctx.ownerId);
  const { blindedMsg, inv } = await blind(key, preparedMsg);
  const blindSig = issuer.blindSign(blindedMsg);
  const sig = await finalize(key, preparedMsg, blindSig, inv);
  return { ctx, msgPrefix, sig, preparedMsg };
}

export const ctxHex = (c: BadgeContext) => ({
  net: c.net,
  contractId: toHex(c.contractId),
  issuerId: toHex(c.issuerId),
  epoch: c.epoch,
  ownerId: toHex(c.ownerId),
});

/** Reader-side verify of an issued badge under the binding implied by its context. */
export const verifyIssued = (key: IssuerKey, b: IssuedBadge) =>
  verifyBadge(bind(key, b.ctx), { ownerId: b.ctx.ownerId, msgPrefix: b.msgPrefix, sig: b.sig });
