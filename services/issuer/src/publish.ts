// `issuer publish-keys` (OFFLINE, CRITICAL key): publish the manifest's issuerKey documents. The contract allows one issuerKey per
// (issuer, epoch), immutable and non-deletable, so a publish can never replace a key: a slot that already holds OUR key (an earlier
// run, or a write that landed although the SDK reported an error) is adopted, and a slot holding any other key is a conflict.
// Readers accept a key created before keyDeadline(E) = S(E+1) - margin, so the current epoch's key can still be published.
import { deriveKeyId, equalBytes, keyDeadline, toHex, VARIANT, type EpochParams } from '@govhub/badge';
import type { IdentityKeyFile } from './config.ts';
import { manifestSpki, type ManifestEntry } from './keys.ts';
import { errText } from './log.ts';
import type { IssuerPlatform } from './platform.ts';

export type PublishStatus =
  | 'published'
  | 'already published'
  /** publishing reported an error, but the slot holds this key: the write landed, or an earlier one did */
  | 'adopted'
  /** the slot holds another key (or ours in a form readers reject): final. If the operator did not publish it, the CRITICAL key is compromised */
  | 'conflict'
  /** it could not land before keyDeadline any more */
  | 'too late'
  /** publishing failed and the slot is still empty, the manifest entry is inconsistent, or our key landed after the deadline */
  | 'error';

export interface PublishResult {
  epoch: number;
  status: PublishStatus;
  keyId: string;
  /** readers accept the key only if it was created below this core height */
  deadline: number;
  id?: string;
  createdAtCoreBlockHeight?: number;
  note?: string;
}

type Platform = Pick<IssuerPlatform, 'issuerKey' | 'coreHeight' | 'publishIssuerKey'>;
type Base = Pick<PublishResult, 'epoch' | 'keyId' | 'deadline'>;

/** What the slot holds: null (empty), our usable key ('already published'), or a conflict / error. */
async function readSlot(platform: Platform, key: IdentityKeyFile, base: Base, spki: Uint8Array): Promise<PublishResult | null> {
  const doc = await platform.issuerKey(key.identityId, base.epoch);
  if (!doc) return null;
  const found = { ...base, createdAtCoreBlockHeight: doc.createdAtCoreBlockHeight };
  if (!equalBytes(doc.spki, spki)) return { ...found, status: 'conflict', keyId: toHex(doc.keyId), note: 'a different key is published for this epoch and cannot be replaced. If you did not publish it, the CRITICAL key is compromised (README "Revoking a key")' };
  if (doc.variant !== VARIANT || toHex(doc.keyId) !== base.keyId) return { ...found, status: 'conflict', note: 'our SPKI is published with another variant or keyId: readers reject it and the slot is used. If you did not publish it, the CRITICAL key is compromised' };
  if (doc.createdAtCoreBlockHeight >= base.deadline) return { ...found, status: 'error', note: 'this key is published, but it landed at or after the deadline: readers reject it and the slot is used' };
  return { ...found, status: 'already published' };
}

async function publishOne(platform: Platform, key: IdentityKeyFile, m: ManifestEntry, p: EpochParams): Promise<PublishResult> {
  const base: Base = { epoch: m.epoch, keyId: m.keyId, deadline: keyDeadline(p, m.epoch) };
  const spki = manifestSpki(m);
  const keyId = await deriveKeyId(spki);
  if (toHex(keyId) !== m.keyId) return { ...base, status: 'error', note: 'manifest.json: keyId != SHA256(spki); regenerate this key' };
  const peek = () => readSlot(platform, key, base, spki).catch(() => null);
  const existing = await readSlot(platform, key, base, spki);
  if (existing) return existing;
  // leave a few blocks for the write to land
  const height = await platform.coreHeight();
  if (height + p.boundaryMarginBlocks >= base.deadline) return { ...base, status: 'too late', note: `platform core height ${height}: it would not land before the deadline` };
  let id: string;
  try {
    id = await platform.publishIssuerKey(key, { epoch: m.epoch, spki, keyId });
  } catch (e) {
    // The unique index makes a duplicate harmless: whatever is in the slot now decides.
    const now = await peek();
    if (now?.status === 'already published') return { ...now, status: 'adopted', note: `publishing reported "${errText(e)}", but this key is on Platform` };
    return now ?? { ...base, status: 'error', note: `publishing failed: ${errText(e)}` };
  }
  const back = await peek();
  if (!back) return { ...base, status: 'published', id, note: 'not yet visible in a proved read' };
  return back.status === 'already published' ? { ...back, status: 'published', id } : { ...back, id };
}

export async function publishKeys(platform: Platform, key: IdentityKeyFile, manifest: readonly ManifestEntry[], p: EpochParams): Promise<PublishResult[]> {
  const out: PublishResult[] = [];
  for (const m of manifest) out.push(await publishOne(platform, key, m, p));
  return out;
}

/** 3: a slot holds another key; 1: an error; 0 otherwise. */
export function publishExitCode(results: readonly PublishResult[]): number {
  if (results.some((r) => r.status === 'conflict')) return 3;
  if (results.some((r) => r.status === 'error')) return 1;
  return 0;
}
