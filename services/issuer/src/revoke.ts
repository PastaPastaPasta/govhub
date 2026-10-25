// `issuer revoke` (OFFLINE, CRITICAL key): publish issuerRevocation documents. Readers (packages/badge reader.ts) treat any
// revocation the issuer published for (issuer, E) as voiding E's key from its effectiveCoreHeight on: badges created at or after
// that height are not shown. The document is immutable, cannot be deleted, and is unique per (issuer, epoch), so a revocation can
// never be moved or replaced: the plan is printed first, and nothing is published without `--yes`.
import { toHex } from '@govhub/badge';
import type { IdentityKeyFile } from './config.ts';
import type { IssuerPlatform } from './platform.ts';

const U32_MAX = 0xffffffff;

export interface RevokeOptions {
  /** epochs to revoke, each from `fromHeight` */
  epochs: number[];
  fromHeight: number;
  /** false: report what would be published, publish nothing */
  publish: boolean;
}

export type RevokeStatus =
  /** published now (or would be, in a dry run) */
  | 'published'
  | 'would publish'
  /** this epoch already has a revocation at or below the height: it already voids at least what was asked */
  | 'already revoked'
  /** a revocation with a LATER height occupies the slot (published earlier by the issuer, or by someone holding its CRITICAL key) */
  | 'conflict';

export interface RevokeResult {
  epoch: number;
  status: RevokeStatus;
  /** the revoked key, hex; all zeros when no issuerKey was published for the epoch */
  keyId: string;
  /** the effective height of the revocation now in force (ours, or the existing one) */
  effectiveCoreHeight: number;
  note?: string;
  id?: string;
}

export function parseEpochRange(from: number, through: number | undefined): number[] {
  const to = through ?? from;
  if (!Number.isInteger(from) || from < 1 || from > U32_MAX) throw new Error('--epoch must be a positive integer');
  if (!Number.isInteger(to) || to < from) throw new Error('--through must be an epoch at or after --epoch');
  if (to - from >= 64) throw new Error('at most 64 epochs per run');
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export async function revokeEpochs(platform: Pick<IssuerPlatform, 'issuerKey' | 'issuerRevocation' | 'publishIssuerRevocation'>, key: IdentityKeyFile, o: RevokeOptions): Promise<RevokeResult[]> {
  if (!Number.isInteger(o.fromHeight) || o.fromHeight < 0 || o.fromHeight > U32_MAX) throw new Error('--from-height must be a core height (0..4294967295)');
  const out: RevokeResult[] = [];
  for (const epoch of o.epochs) {
    const existing = await platform.issuerRevocation(key.identityId, epoch);
    if (existing) {
      const keyId = toHex(existing.keyId);
      if (existing.effectiveCoreHeight <= o.fromHeight) {
        out.push({ epoch, status: 'already revoked', keyId, effectiveCoreHeight: existing.effectiveCoreHeight });
      } else {
        out.push({
          epoch,
          status: 'conflict',
          keyId,
          effectiveCoreHeight: existing.effectiveCoreHeight,
          note: `a revocation from height ${existing.effectiveCoreHeight} (created at ${existing.createdAtCoreBlockHeight}) already occupies this epoch's slot and cannot be replaced: badges created before it stay valid. If you did not publish it, the CRITICAL key is compromised (README "Revoking a key")`,
        });
      }
      continue;
    }
    const issuerKey = await platform.issuerKey(key.identityId, epoch);
    // Readers do not compare the revocation's keyId with the key (any revocation for the epoch counts), so an epoch without a key
    // can be revoked too: a key published for it later is void from the height on.
    const keyId = issuerKey ? issuerKey.keyId : new Uint8Array(32);
    const note = issuerKey ? undefined : 'no issuerKey is published for this epoch: any key published for it later is void from this height on';
    if (!o.publish) {
      out.push({ epoch, status: 'would publish', keyId: toHex(keyId), effectiveCoreHeight: o.fromHeight, ...(note ? { note } : {}) });
      continue;
    }
    const id = await platform.publishIssuerRevocation(key, { epoch, keyId, effectiveCoreHeight: o.fromHeight });
    out.push({ epoch, status: 'published', keyId: toHex(keyId), effectiveCoreHeight: o.fromHeight, id, ...(note ? { note } : {}) });
  }
  return out;
}
