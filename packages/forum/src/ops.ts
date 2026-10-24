// Write operations as plain data. A signer (apps/web `Session.signAndBroadcastDocument`) turns a DocumentOp into a
// signed state transition; nothing here touches the network or keys. Builders validate what consensus would
// reject (and what consensus would accept but the UI must not: comment bodies over 5,000 UTF-8 bytes).
import { BLOCK_KIND, CLAIM_METHOD, COMMENT_FMT, COMMENT_MAX_BYTES, REACTION_KIND, type ContractKey, type ForumContracts, type ProposalPost, type Reaction } from './types.ts';
import { hexToBytes, idToBytes, isHash64, isIdentifier } from './encoding.ts';
import { packLists } from './convert.ts';
import { SCHEMAS } from './queries.ts';

/**
 * A document field value. Byte arrays and identifiers are Uint8Array (the signer hands them to the SDK as bytes),
 * integers are JS numbers (the signer converts them to the SDK's bigint), plus strings and booleans.
 * `$createdAt` / `$updatedAt` are included by the builders when the type requires them (ms; Drive overwrites them
 * with block time on creation).
 */
export type DocValue = string | number | boolean | Uint8Array;
export type DocData = Record<string, DocValue>;

export type DocumentOp =
  | { action: 'create'; contractId: string; type: string; data: DocData }
  /** `revision` is the stored revision being replaced; the signer writes revision + 1. `data` is the full new document. */
  | { action: 'replace'; contractId: string; type: string; id: string; revision: number; data: DocData }
  | { action: 'delete'; contractId: string; type: string; id: string };

export interface DocumentResult {
  /** base58 document id (derived by the signer for creates) */
  id: string;
  /** revision after the write (1 for creates) */
  revision?: number;
}

/** The DocumentOp builders for one set of contract ids. */
export function forumOps(contracts: ForumContracts, now: () => number = Date.now) {
  const stamps = (contract: ContractKey, type: string, onCreate: boolean): DocData => {
    const req = (SCHEMAS[contract][type] as { required?: string[] } | undefined)?.required ?? [];
    const t = now();
    const out: DocData = {};
    if (onCreate && req.includes('$createdAt')) out.$createdAt = t;
    if (req.includes('$updatedAt')) out.$updatedAt = t;
    return out;
  };
  const create = (contract: ContractKey, type: string, data: DocData): DocumentOp => ({ action: 'create', contractId: contracts[contract], type, data: { ...stamps(contract, type, true), ...data } });
  const replace = (contract: ContractKey, type: string, id: string, revision: number, data: DocData): DocumentOp => ({
    action: 'replace',
    contractId: contracts[contract],
    type,
    id,
    revision,
    data: { ...stamps(contract, type, false), ...data },
  });
  const del = (contract: ContractKey, type: string, id: string): DocumentOp => ({ action: 'delete', contractId: contracts[contract], type, id });
  const hash = (h: string): Uint8Array => {
    if (!isHash64(h)) throw new Error('govHash must be 64 lowercase hex characters');
    return hexToBytes(h);
  };

  return {
    comment(govHash: string, body: string, opts: { parentId?: string; fmt?: number } = {}): DocumentOp {
      const n = new TextEncoder().encode(body).length;
      if (body.trim().length === 0) throw new Error('comment is empty');
      if (n > COMMENT_MAX_BYTES) throw new Error(`comment is ${n} bytes; the limit is ${COMMENT_MAX_BYTES}`);
      if (body.length > 5000) throw new Error('comment is longer than 5,000 characters');
      if (opts.parentId !== undefined && !isIdentifier(opts.parentId)) throw new Error('parentId must be a document id');
      return create('forum', 'comment', { govHash: hash(govHash), body, fmt: opts.fmt ?? COMMENT_FMT.markdown, ...(opts.parentId ? { parentId: idToBytes(opts.parentId) } : {}) });
    },
    retractComment: (id: string) => del('forum', 'comment', id),

    /** Up/down vote. With an existing reaction: same value = clear (delete), other value = flip (replace). */
    react(target: { govHash: string } | { commentId: string }, value: 1 | -1, existing?: Pick<Reaction, 'id' | 'revision' | 'value'>): DocumentOp {
      if (existing && existing.value === value) return del('forum', 'reaction', existing.id);
      const kind = 'govHash' in target ? REACTION_KIND.proposal : REACTION_KIND.comment;
      const bytes = 'govHash' in target ? hash(target.govHash) : idToBytes(target.commentId);
      const data = { target: bytes, kind, value };
      return existing ? replace('forum', 'reaction', existing.id, existing.revision, data) : create('forum', 'reaction', data);
    },
    clearReaction: (id: string) => del('forum', 'reaction', id),

    profile(fields: { displayName: string; about?: string; avatarUrl?: string }, existing?: { id: string; revision: number }): DocumentOp {
      const displayName = fields.displayName.trim();
      if (displayName.length < 1 || displayName.length > 64) throw new Error('display name must be 1..64 characters');
      const data: DocData = { displayName };
      const about = fields.about?.trim();
      const avatarUrl = fields.avatarUrl?.trim();
      if (about) data.about = about.slice(0, 500);
      if (avatarUrl) data.avatarUrl = avatarUrl.slice(0, 512);
      return existing ? replace('forum', 'profile', existing.id, existing.revision, data) : create('forum', 'profile', data);
    },

    claim(govHash: string, method: typeof CLAIM_METHOD.paymentAddress | typeof CLAIM_METHOD.collateralInput, sig: Uint8Array): DocumentOp {
      if (sig.length !== 65) throw new Error('a claim signature is 65 bytes');
      return create('forum', 'claim', { govHash: hash(govHash), method, sig });
    },
    retractClaim: (id: string) => del('forum', 'claim', id),

    /** `chunks` comes from packPostBody (≤ 3 × 5,120 B). */
    proposalPost(govHash: string, title: string, chunks: readonly Uint8Array[], existing?: Pick<ProposalPost, 'id' | 'revision'>, links?: string): DocumentOp {
      const t = title.trim();
      if (t.length < 1 || t.length > 200) throw new Error('title must be 1..200 characters');
      if (chunks.length < 1 || chunks.length > 3 || chunks.some((c) => c.length < 1 || c.length > 5120)) throw new Error('body must be 1..3 chunks of 1..5,120 bytes');
      const data: DocData = { govHash: hash(govHash), title: t };
      chunks.forEach((c, i) => (data[`b${i}`] = c));
      if (links?.trim()) data.links = links.trim().slice(0, 1000);
      return existing ? replace('forum', 'proposalPost', existing.id, existing.revision, data) : create('forum', 'proposalPost', data);
    },

    /** A block on the user's own list (`forum`), or on the default list (`mod`, moderation identity only). */
    block(list: 'forum' | 'mod', target: string, kind: (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND], reason?: string): DocumentOp {
      if (!isIdentifier(target)) throw new Error('block target must be an identity or document id');
      const r = reason?.trim();
      return create(list, 'block', { target: idToBytes(target), kind, ...(r ? { reason: r.slice(0, 280) } : {}) });
    },
    unblock: (list: 'forum' | 'mod', id: string) => del(list, 'block', id),

    blockSubs(lists: readonly string[], defaultOff: boolean, existing?: { id: string; revision: number }): DocumentOp {
      if (lists.length > 160) throw new Error('at most 160 subscribed lists');
      const data: DocData = { defaultOff, ...(lists.length ? { lists: packLists(lists) } : {}) };
      return existing ? replace('forum', 'blockSubs', existing.id, existing.revision, data) : create('forum', 'blockSubs', data);
    },
  };
}

export type ForumOps = ReturnType<typeof forumOps>;
