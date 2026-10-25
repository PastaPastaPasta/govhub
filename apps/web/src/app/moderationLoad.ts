// Reading the moderation lists a reader applies (PLAN §9): the subscriptions (the user's blockSubs document when signed in,
// else this browser's), then every list they name plus the user's own. Every read has a deadline: a node that never answers
// counts as a list that could not be read (fail closed, with "Show the comments anyway"), never as "Applying block lists…" forever.
import { isIdentifier, type BlockList, type ForumReader } from '@govhub/forum';
import { shortHash } from '../lib/format.ts';
import { withDeadline } from '../lib/social.ts';

/** Which lists the reader applies: the default list unless turned off, plus subscribed list owners. */
export interface Subscriptions {
  defaultOff: boolean;
  lists: string[];
  /** where these came from: this browser, or the user's `blockSubs` document (id + revision for replacing it) */
  doc?: { id: string; revision: number };
}

/** How long one list (all its pages) or the subscriptions document may take. */
const LIST_DEADLINE_MS = 20_000;

const SUBS_KEY = 'govhub.blockSubs.v1';

export function loadLocalSubs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Subscriptions {
  try {
    const v = JSON.parse(storage?.getItem(SUBS_KEY) ?? 'null') as { defaultOff?: unknown; lists?: unknown } | null;
    const lists = Array.isArray(v?.lists) ? v.lists.filter(isIdentifier).slice(0, 160) : [];
    return { defaultOff: v?.defaultOff === true, lists: [...new Set(lists)] };
  } catch {
    return { defaultOff: false, lists: [] };
  }
}

export const saveLocalSubs = (s: Subscriptions) => localStorage.setItem(SUBS_KEY, JSON.stringify({ defaultOff: s.defaultOff, lists: s.lists }));

export type ListReader = Pick<ForumReader, 'blocks' | 'blockSubs'>;

export interface ModerationRead {
  lists: BlockList[];
  subs: Subscriptions;
  /** names of the lists that failed or did not answer in time */
  failed: string[];
}

export async function readModeration(
  reader: ListReader,
  o: { identityId: string | null; moderationIdentityId: string; moderationName: string; localSubs: Subscriptions; deadlineMs?: number },
): Promise<ModerationRead> {
  const ms = o.deadlineMs ?? LIST_DEADLINE_MS;
  let subs = o.localSubs;
  const failed: string[] = [];
  if (o.identityId) {
    // Unreadable subscriptions fall back to this browser's, and fail closed: lists subscribed on Platform would be missing.
    const doc = await withDeadline(reader.blockSubs(o.identityId), ms, 'your list subscriptions').catch(() => {
      failed.push('your list subscriptions');
      return null;
    });
    if (doc) subs = { defaultOff: doc.defaultOff, lists: doc.lists, doc: { id: doc.id, revision: doc.revision } };
  }
  const wanted: Array<{ source: BlockList['source']; contract: 'forum' | 'mod'; ownerId: string; name: string }> = [];
  if (!subs.defaultOff) wanted.push({ source: 'default', contract: 'mod', ownerId: o.moderationIdentityId, name: o.moderationName });
  for (const owner of subs.lists) wanted.push({ source: 'subscription', contract: 'forum', ownerId: owner, name: `list ${shortHash(owner, 4)}` });
  if (o.identityId) wanted.push({ source: 'mine', contract: 'forum', ownerId: o.identityId, name: 'your blocks' });
  const settled = await Promise.allSettled(wanted.map((w) => withDeadline(reader.blocks(w.contract, w.ownerId), ms, w.name)));
  const lists: BlockList[] = [];
  settled.forEach((r, i) => {
    const w = wanted[i]!;
    if (r.status === 'fulfilled') lists.push({ source: w.source, ownerId: w.ownerId, name: w.name, blocks: r.value });
    else failed.push(w.name);
  });
  return { lists, subs, failed };
}

/** The notice for lists that failed: "The block list govhub moderation could not be read". */
export const failedText = (failed: readonly string[]): string => `${failed.length === 1 ? 'The block list' : 'The block lists'} ${failed.join(', ')} could not be read`;
