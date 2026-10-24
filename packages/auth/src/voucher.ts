// Faucet vouchers (PLAN 4.3): a pre-minted, ChainLocked asset lock whose credit output pays a one-time key handed to the user as
// `dashpay://invite?assetlocktx=<txid>&pk=<WIF>&islock=null` (dash-faucet-cf invitationUri). Redeeming creates an identity with the
// user's OWN seed keys; the voucher key only signs the asset-lock proof, so the faucet never controls the identity.
// The credit index is read from the transaction (dash-faucet-cf sorts outputs BIP69-style, so the burn can sit at any vout; Platform
// indexes the payload's credit outputs, see tx.ts locateCredit).
import { parseTx, type Dapi } from '@govhub/dapi';
import { bytesEqual, hash160, hexToBytes, wipe } from './bytes.ts';
import { parsePrivateKey, publicKeyOf, type Network } from './keys.ts';
import { CREATE_KEYS } from './layout.ts';
import type { AssetLockProofInput, PlatformPort, SigningKey } from './platform.ts';
import type { SeedWallet } from './seed.ts';
import { identityIdFromOutpoint, locateCredit } from './tx.ts';
import { minedHeight, redact, waitForChainLockedHeight } from './funding.ts';

export interface Voucher {
  txid: string;
  privateKey: Uint8Array;
  /** IS-lock bytes when the link carries them (the faucet sends the literal "null": chain proof). */
  isLock: Uint8Array | null;
}

export class VoucherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherError';
  }
}

/** Reads a voucher link (dashpay://invite?..., or any URL / query string with `assetlocktx` and `pk`). The error never echoes the key. */
export function parseVoucher(text: string, network: Network): Voucher {
  const t = text.trim();
  const q = t.includes('?') ? t.slice(t.indexOf('?') + 1) : t;
  const p = new URLSearchParams(q);
  const txid = (p.get('assetlocktx') ?? '').toLowerCase();
  const pk = p.get('pk') ?? '';
  if (!/^[0-9a-f]{64}$/.test(txid) || !pk) throw new VoucherError('That is not a voucher link (it needs assetlocktx and pk).');
  const isl = p.get('islock');
  let isLock: Uint8Array | null = null;
  if (isl && isl !== 'null' && /^[0-9a-fA-F]+$/.test(isl) && isl.length % 2 === 0) isLock = hexToBytes(isl);
  return { txid, privateKey: parsePrivateKey(pk, network), isLock };
}

export interface RedeemOptions {
  voucher: Voucher;
  wallet: SeedWallet;
  identityIndex: number;
  dapi: Dapi;
  platform: PlatformPort;
  pollMs?: number;
  signal?: AbortSignal;
  onUpdate?(note: string, identityId?: string): void;
}

/** Creates a new identity with the seed's keys at `identityIndex`, funded by the voucher. Returns the identity id. */
export async function redeemVoucher(o: RedeemOptions): Promise<{ identityId: string; creditDuffs: bigint; proofKind: 'instant' | 'chain' }> {
  const { voucher, wallet, dapi, platform, signal } = o;
  const keys: SigningKey[] = [];
  try {
    o.onUpdate?.('reading the voucher transaction');
    const { value: claim } = await dapi.call((core, s) => core.getTransaction(voucher.txid, { signal: s }), { signal });
    const tx = parseTx(claim.raw);
    if (tx.txid !== voucher.txid) throw new VoucherError('the node returned a different transaction');
    const { creditIndex, creditDuffs } = locateCredit(tx, hash160(publicKeyOf(voucher.privateKey)));
    const identityId = identityIdFromOutpoint(tx.txid, creditIndex);
    o.onUpdate?.('voucher found', identityId);
    if ((await platform.identityKeys(identityId)) !== null) {
      // Already redeemed. If it was by this seed (an interrupted earlier attempt), that is success.
      const mine = wallet.identityKey(o.identityIndex, 0);
      const k = await platform.identityKeys(identityId);
      const ok = k?.some((x) => x.id === 0 && bytesEqual(x.data, mine.publicKey));
      wipe(mine.privateKey);
      if (ok) return { identityId, creditDuffs, proofKind: 'chain' };
      throw new VoucherError('This voucher has already been used.');
    }
    for (const k of CREATE_KEYS) keys.push({ ...k, privateKey: wallet.identityKey(o.identityIndex, k.id).privateKey });
    let proof: AssetLockProofInput | null = voucher.isLock ? { kind: 'instant', tx: claim.raw, isLock: voucher.isLock, creditIndex } : null;
    if (proof) {
      try {
        await platform.createIdentity({ proof, assetLockKey: voucher.privateKey, keys });
      } catch (e) {
        proof = null;
        o.onUpdate?.(`IS-lock proof refused (${redact(String((e as Error)?.message ?? e)).slice(0, 120)}); using a chain-lock proof`);
      }
    }
    if (!proof) {
      if (!(await minedHeight(dapi, tx.txid, signal))) o.onUpdate?.('waiting for the voucher to be mined');
      const cl = await waitForChainLockedHeight(dapi, platform, tx.txid, { pollMs: o.pollMs, signal, onWait: (m, p) => o.onUpdate?.(m ? `mined at ${m}; waiting for Platform's chain lock (${p})` : 'waiting for the voucher to be mined') });
      proof = { kind: 'chain', txid: tx.txid, creditIndex, coreChainLockedHeight: cl };
      o.onUpdate?.('registering the identity');
      await platform.createIdentity({ proof, assetLockKey: voucher.privateKey, keys });
    }
    for (let i = 0; (await platform.identityKeys(identityId)) === null; i++) {
      if (i >= 20) throw new VoucherError('Platform accepted the identity but it is not visible yet. Try signing in with your phrase in a minute.');
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { identityId, creditDuffs, proofKind: proof.kind };
  } finally {
    for (const k of keys) wipe(k.privateKey);
  }
}
