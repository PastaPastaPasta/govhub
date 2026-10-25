// Pure helpers behind the discussion and ownership UI (govhub QA fix group F4), kept here so they are unit-tested without a DOM.
import { badgeLike, cleanName, flatten, type Profile, type ThreadNode } from '@govhub/forum';
import { canOutrank, CLAIM_METHOD_LABEL, type ClaimMethodId, type ClaimVerdict } from '@govhub/verify';
import { shortHash } from './format.ts';

// ---- names (D-035) --------------------------------------------------------------------------------------------------------
export interface AuthorLabel {
  /** the proof-verified DPNS name, when the identity has one: shown first */
  dpns: string | null;
  /** the self-chosen display name with invisible characters removed, or null */
  name: string | null;
  /** the display name reads like a govhub label (owner, verified, a check mark): shown in quotes so it cannot pass for a chip */
  quoted: boolean;
  /** short identity id, always shown next to a name */
  shortId: string;
}

export function authorLabel(id: string, profile?: Pick<Profile, 'displayName'> | null, dpns?: string | null): AuthorLabel {
  const name = profile?.displayName ? cleanName(profile.displayName) || null : null;
  return { dpns: dpns || null, name, quoted: !!name && badgeLike(name), shortId: shortHash(id, 4) };
}

/** One line of plain text for labels (aria-label, title): DPNS name, else the cleaned display name, else the id. */
export function authorText(id: string, profile?: Pick<Profile, 'displayName'> | null, dpns?: string | null): string {
  const a = authorLabel(id, profile, dpns);
  return a.dpns ?? (a.name ? `${a.quoted ? `"${a.name}"` : a.name} (${a.shortId})` : id);
}

// ---- claims (D-036) -------------------------------------------------------------------------------------------------------
/** How a listed claim is labelled: only a claim that was checked and failed is "Failed verification". */
export function rejectedChip(reason: string): { text: string; bad: boolean } {
  return reason.startsWith('not checked') ? { text: 'Not checked', bad: false } : { text: 'Failed verification', bad: true };
}

/**
 * Why publishing a claim with `method` now would not make `me` the owner, shown before anything is paid; null when it can win.
 * A new claim is the newest, so it wins only with a strictly stronger method than the current owner's.
 */
export function claimWarning(v: Pick<ClaimVerdict, 'owner' | 'named'> | null, method: ClaimMethodId, me: string): string | null {
  const o = v?.owner ?? null;
  if (o && !canOutrank(o, method)) {
    const who = o.identityId === me ? 'Your earlier claim' : `A claim by ${shortHash(o.identityId, 4)}`;
    return `${who} (${CLAIM_METHOD_LABEL[o.method]}) already owns this proposal. Claims rank by method, then by age, so a new claim with a ${CLAIM_METHOD_LABEL[method]} ranks below it and cannot take over: it would be listed as valid but outranked.`;
  }
  if (v?.named && !v.named.accepted && v.named.identityId !== me) {
    return `The proposal URL names identity ${shortHash(v.named.identityId, 4)}. If it accepts, it outranks every signature claim, including this one.`;
  }
  return null;
}

// ---- thread window (D-038) ------------------------------------------------------------------------------------------------
/**
 * The newest root threads holding at most about `limit` shown comments (whole threads, at least one), plus the thread holding
 * `focus` wherever it is. Only these are rendered, and only rendered comments have their reactions read.
 */
export function windowRoots(roots: readonly ThreadNode[], visible: ReadonlyMap<string, boolean>, limit: number, focus: string | null): { roots: ThreadNode[]; older: number } {
  const size = (r: ThreadNode) => flatten([r]).filter((n) => visible.get(n.comment.id)).length;
  const keep = new Set<ThreadNode>();
  let n = 0;
  let older = 0;
  for (let i = roots.length - 1; i >= 0; i--) {
    const r = roots[i]!;
    const s = size(r);
    if (s === 0) continue;
    if (n === 0 || n + s <= limit) {
      keep.add(r);
      n += s;
    } else older += s;
  }
  if (focus) {
    const r = roots.find((x) => !keep.has(x) && flatten([x]).some((c) => c.comment.id === focus));
    if (r) {
      keep.add(r);
      older -= size(r);
    }
  }
  return { roots: roots.filter((r) => keep.has(r)), older };
}

// ---- deadlines (D-039) ----------------------------------------------------------------------------------------------------
export class DeadlineError extends Error {}

/** `p`, or a DeadlineError after `ms` (the timer is cleared either way). */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
