// The data layer end to end over the in-memory store: writes as DocumentOps, reads through the linted queries,
// paging past 100, threading, scores, moderation and the conversions of SDK document JSON.
import { describe, expect, it } from 'vitest';
import {
  buildHideIndex,
  buildThreads,
  ancestors,
  MAX_THREAD_DEPTH,
  visibleSubtrees,
  flatten,
  forumOps,
  ForumReader,
  MemoryStore,
  passesFilter,
  defaultFilter,
  score,
  targetB64,
  toComment,
  toReaction,
  toBlockSubs,
  packLists,
  idToHex,
  commentCost,
  postCost,
  COSTS,
  type Comment,
  type DocReader,
  type ForumContracts,
} from '../src/index.ts';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';

const C: ForumContracts = {
  forum: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw',
  mod: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY',
  gov: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ',
};
const MOD = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
const ALICE = '4eYvJ1QzRxFy82CRK3tP5QHmdRcgkG8xdbGBQMqSroif';
const BOB = '4TEp8FeD7iMD9nKMGBK492ZnbESdwFPPXtvjRA6Zrxhv';
const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
const H2 = 'f64341933c383620eb01d3eb8dccebf6400490a03b1cf0a7d2700747d8a4163b';

function setup() {
  let t = 1_792_800_000_000;
  const now = () => (t += 1000);
  const store = new MemoryStore({ contracts: C, owners: { mod: MOD, gov: MOD }, now });
  return { store, reader: new ForumReader(store), ops: forumOps(C, now) };
}

describe('writes and reads through the linted queries', () => {
  it('comments, replies and paging past 100', async () => {
    const { store, reader, ops } = setup();
    const first = store.apply(ALICE, ops.comment(H, 'first'));
    store.apply(BOB, ops.comment(H, 'reply', { parentId: first.id }));
    for (let i = 0; i < 150; i++) store.apply(BOB, ops.comment(H, `c${i}`, { fmt: 0 }));
    store.apply(BOB, ops.comment(H2, 'elsewhere'));
    const r = await reader.comments(H);
    expect(r.comments).toHaveLength(152);
    expect(r.truncated).toBe(false);
    expect(r.comments[0]!.body).toBe('first');
    expect(r.comments[1]).toMatchObject({ parentId: first.id, ownerId: BOB, fmt: 1 });
    expect(new Set(r.comments.map((c) => c.id)).size).toBe(152);
    const since = await reader.commentsSince(H, r.comments[149]!.createdAt);
    expect(since.map((c) => c.body)).toEqual(['c147', 'c148', 'c149']); // >= : the boundary time itself is read again
  });

  it('newest-first paging bounds by time, never startAfter (R8), and loses nothing when one block time spans a page boundary', async () => {
    let t = 1_792_800_000_000;
    let n = 0;
    // 30 comments per block time: page boundaries (every 100) fall inside a block
    const now = () => (n++ % 30 === 0 ? (t += 1000) : t);
    const store = new MemoryStore({ contracts: C, owners: { mod: MOD, gov: MOD }, now });
    const reader = new ForumReader(store);
    const ops = forumOps(C, now);
    const sent: DocQuery[] = [];
    const spy: DocReader = { query: (c, q) => (sent.push(q), store.query(c, q)) };
    for (let i = 0; i < 250; i++) store.apply(BOB, ops.comment(H, `c${i}`));
    const r = await new ForumReader(spy).comments(H);
    expect(r.truncated).toBe(false);
    expect(r.comments).toHaveLength(250);
    expect(new Set(r.comments.map((c) => c.id)).size).toBe(250);
    expect(r.comments.map((c) => c.createdAt)).toEqual([...r.comments.map((c) => c.createdAt)].sort((a, b) => a - b));
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((q) => q.startAfter === undefined)).toBe(true);
    expect(sent[1]!.where[1]).toEqual(['$createdAt', '<=', expect.any(Number)]);
    // commentsSince at a shared block time returns that whole block again (callers skip ids they hold)
    const last = r.comments.at(-1)!.createdAt;
    expect((await reader.commentsSince(H, last)).length).toBe(r.comments.filter((c) => c.createdAt === last).length);
  });

  it('more than a page of comments in one block hides nothing older: that block time is swept ascending, then the read goes on', async () => {
    let t = 1_792_800_000_000;
    const now = () => t;
    const store = new MemoryStore({ contracts: C, owners: { mod: MOD, gov: MOD }, now });
    const ops = forumOps(C, now);
    for (let i = 0; i < 5; i++, t += 1000) store.apply(ALICE, ops.comment(H, `old${i}`));
    for (let i = 0; i < 230; i++) store.apply(BOB, ops.comment(H, `burst${i}`)); // one block time, more than two pages
    t += 1000;
    store.apply(ALICE, ops.comment(H, 'newest'));
    const sent: DocQuery[] = [];
    const spy: DocReader = { query: (c, q) => (sent.push(q), store.query(c, q)) };
    const r = await new ForumReader(spy).comments(H);
    expect(r.truncated).toBe(false);
    expect(r.comments).toHaveLength(236);
    expect(new Set(r.comments.map((c) => c.id)).size).toBe(236);
    expect(r.comments.slice(0, 5).map((c) => c.body)).toEqual(['old0', 'old1', 'old2', 'old3', 'old4']);
    expect(r.comments.at(-1)!.body).toBe('newest');
    // desc pages never carry startAfter; only the ascending one-key sweep does
    for (const q of sent) if (q.orderBy?.some(([, d]) => d === 'desc')) expect(q.startAfter).toBeUndefined();
    expect(sent.some((q) => q.where.some((w) => w[1] === '==' && w[0] === '$createdAt'))).toBe(true);
  });

  it('a page cap still bounds the read (truncated)', async () => {
    const store = new MemoryStore({ contracts: C, owners: { mod: MOD, gov: MOD }, now: () => 1_792_800_000_000 });
    const ops = forumOps(C, () => 1_792_800_000_000);
    for (let i = 0; i < 120; i++) store.apply(BOB, ops.comment(H, `c${i}`));
    const r = await new ForumReader(store).comments(H, 1);
    expect(r.truncated).toBe(true);
    expect(r.comments).toHaveLength(100);
  });

  it('comment bodies are capped at 5,000 UTF-8 bytes, not characters', () => {
    const { ops } = setup();
    expect(() => ops.comment(H, 'x'.repeat(5000))).not.toThrow();
    expect(() => ops.comment(H, '€'.repeat(1667))).toThrow(/5001 bytes/);
    expect(() => ops.comment(H, '   ')).toThrow(/empty/);
    expect(() => ops.comment(H, 'x', { parentId: 'nope' })).toThrow(/parentId/);
  });

  it('builders stamp the system fields the type requires', () => {
    const { ops } = setup();
    const c = ops.comment(H, 'x');
    expect(c.action === 'create' && typeof c.data.$createdAt).toBe('number');
    expect(c.action === 'create' && c.data.$updatedAt).toBeUndefined();
    const r = ops.react({ commentId: ALICE }, 1);
    expect(r.action === 'create' && typeof r.data.$updatedAt).toBe('number');
    const p = ops.profile({ displayName: 'a' });
    expect(p.action === 'create' && p.data.$createdAt).toBeUndefined();
  });

  it('reactions: create, flip by replace, clear by delete; one per owner and target', async () => {
    const { store, reader, ops } = setup();
    const c = store.apply(ALICE, ops.comment(H, 'hello'));
    const target = targetB64({ commentId: c.id });
    store.apply(BOB, ops.react({ commentId: c.id }, 1));
    store.apply(ALICE, ops.react({ commentId: c.id }, 1));
    expect(() => store.apply(BOB, ops.react({ commentId: c.id }, -1))).toThrow(/duplicate unique/);
    let rs = await reader.reactions(target);
    const tHex = idToHex(c.id);
    expect(score(rs, { kind: 1, target: tHex })).toMatchObject({ up: 2, down: 0, net: 2 });
    const bobs = rs.find((r) => r.ownerId === BOB)!;
    const flip = ops.react({ commentId: c.id }, -1, bobs);
    expect(flip.action).toBe('replace');
    store.apply(BOB, flip);
    rs = await reader.reactions(target);
    const s = score(rs, { kind: 1, target: tHex, viewer: BOB });
    expect(s).toMatchObject({ up: 1, down: 1, net: 0 });
    expect(s.mine?.revision).toBe(2);
    const clear = ops.react({ commentId: c.id }, -1, s.mine);
    expect(clear.action).toBe('delete');
    store.apply(BOB, clear);
    expect(score(await reader.reactions(target), { kind: 1, target: tHex, viewer: BOB }).mine).toBeUndefined();
    const mine = await reader.myReactions(ALICE, [target, targetB64({ commentId: ALICE })]);
    expect([...mine.keys()]).toEqual([tHex]);
  });

  it('score ignores other kinds and targets, keeps one per owner and can exclude blocked owners (never the viewer)', () => {
    const base = { id: 'x', revision: 1, createdAt: 1, updatedAt: 1 };
    const rs = [
      { ...base, ownerId: ALICE, target: H, kind: 1, value: 1 as const },
      { ...base, ownerId: ALICE, target: H, kind: 1, value: -1 as const, updatedAt: 5 },
      { ...base, ownerId: BOB, target: H, kind: 1, value: 1 as const },
      { ...base, ownerId: MOD, target: H, kind: 2, value: 1 as const }, // a retired kind (proposal community vote) is ignored
      { ...base, ownerId: MOD, target: H2, kind: 1, value: 1 as const },
    ];
    expect(score(rs, { kind: 1, target: H })).toMatchObject({ up: 1, down: 1 });
    expect(score(rs, { kind: 1, target: H, exclude: (o) => o === BOB })).toMatchObject({ up: 0, down: 1 });
    expect(score(rs, { kind: 1, target: H, viewer: BOB, exclude: (o) => o === BOB })).toMatchObject({ up: 1, down: 1 });
  });

  it('profiles, claims, posts, blocks and subscriptions round-trip', async () => {
    const { store, reader, ops } = setup();
    store.apply(ALICE, ops.profile({ displayName: 'Alice', avatarUrl: 'https://x.org/a.png' }));
    const profiles = await reader.profiles([ALICE, BOB]);
    expect(profiles.get(ALICE)).toMatchObject({ displayName: 'Alice', avatarUrl: 'https://x.org/a.png', revision: 1 });
    expect(profiles.has(BOB)).toBe(false);

    store.apply(ALICE, ops.claim(H, 2, new Uint8Array(65).fill(7)));
    const claims = await reader.claims(H);
    expect(claims[0]).toMatchObject({ ownerId: ALICE, method: 2, govHash: H });
    expect(claims[0]!.sig).toEqual(new Uint8Array(65).fill(7));

    const chunks = [new Uint8Array(5120).fill(1), new Uint8Array(10).fill(2)];
    const created = store.apply(ALICE, ops.proposalPost(H, 'Title', chunks));
    let post = await reader.post(H, ALICE);
    expect(post?.chunks).toEqual(chunks);
    store.apply(ALICE, ops.proposalPost(H, 'Title 2', [new Uint8Array(3).fill(9)], { id: created.id, revision: 1 }));
    post = await reader.post(H, ALICE);
    expect(post).toMatchObject({ title: 'Title 2', revision: 2 });
    expect(post?.chunks).toHaveLength(1);
    expect(await reader.post(H, BOB)).toBeNull();

    expect(() => store.apply(ALICE, ops.block('mod', BOB, 1))).toThrow(/contract owner/);
    store.apply(MOD, ops.block('mod', BOB, 1, 'spam'));
    const b = store.apply(ALICE, ops.block('forum', BOB, 1));
    expect((await reader.blocks('mod', MOD))[0]).toMatchObject({ target: BOB, kind: 1, reason: 'spam' });
    expect(await reader.blocks('forum', ALICE)).toHaveLength(1);
    store.apply(ALICE, ops.unblock('forum', b.id));
    expect(await reader.blocks('forum', ALICE)).toHaveLength(0);

    store.apply(ALICE, ops.blockSubs([BOB, MOD], true));
    expect(await reader.blockSubs(ALICE)).toMatchObject({ lists: [BOB, MOD], defaultOff: true, revision: 1 });
  });

  it('immutable types cannot be replaced and only the owner can delete', () => {
    const { store, ops } = setup();
    const c = store.apply(ALICE, ops.comment(H, 'x'));
    expect(() => store.apply(BOB, ops.retractComment(c.id))).toThrow(/owner/);
    expect(() => store.apply(ALICE, { action: 'replace', contractId: C.forum, type: 'comment', id: c.id, revision: 1, data: {} })).toThrow(/immutable/);
    store.apply(ALICE, ops.retractComment(c.id));
  });
});

describe('conversions of SDK document JSON', () => {
  it('rejects malformed values instead of trusting them', () => {
    const ok = { $id: ALICE, $ownerId: BOB, govHash: Buffer.from(H, 'hex').toString('base64'), body: 'x', fmt: 1, $createdAt: 5 };
    expect(toComment(ok).govHash).toBe(H);
    expect(() => toComment({ ...ok, govHash: Buffer.alloc(31).toString('base64') })).toThrow();
    expect(() => toComment({ ...ok, $ownerId: 'not-an-id' })).toThrow();
    expect(() => toComment({ ...ok, parentId: Buffer.alloc(33, 0xff).toString('base64') })).toThrow();
    expect(toComment({ ...ok, $createdAt: '7' }).createdAt).toBe(7);
    expect(() => toReaction({ $id: ALICE, $ownerId: BOB, target: ok.govHash, kind: 1, value: 0, $createdAt: 1 })).toThrow();
  });

  it('blockSubs.lists packs 32-byte ids', () => {
    const packed = packLists([ALICE, BOB, ALICE]);
    expect(packed.length).toBe(64);
    expect(toBlockSubs({ $id: ALICE, lists: Buffer.from(packed).toString('base64'), defaultOff: false })).toMatchObject({ lists: [ALICE, BOB], defaultOff: false });
    expect(() => toBlockSubs({ $id: ALICE, lists: Buffer.alloc(33).toString('base64'), defaultOff: false })).toThrow();
  });
});

describe('threading', () => {
  const c = (id: string, createdAt: number, parentId?: string, govHash = H): Comment => ({ id, ownerId: ALICE, govHash, body: id, fmt: 0, createdAt, ...(parentId ? { parentId } : {}) });

  it('nests replies under parents, oldest first at every level', () => {
    const roots = buildThreads([c('b', 2), c('a', 1), c('a2', 4, 'a'), c('a1', 3, 'a'), c('a1x', 5, 'a1')]);
    expect(flatten(roots).map((n) => `${'-'.repeat(n.depth)}${n.comment.id}`)).toEqual(['a', '-a1', '--a1x', '-a2', 'b']);
    expect(ancestors(roots, 'a1x')).toEqual(['a', 'a1']);
    expect(ancestors(roots, 'zz')).toEqual([]);
  });

  it('a reply to a missing parent is an orphan root', () => {
    const roots = buildThreads([c('a', 1), c('r', 2, 'gone')]);
    expect(roots.map((n) => [n.comment.id, n.orphan])).toEqual([
      ['a', false],
      ['r', true],
    ]);
  });

  it('cannot form cycles: a parent must be strictly earlier (precomputed-id trick)', () => {
    const roots = buildThreads([c('x', 1, 'y'), c('y', 2, 'x'), c('self', 3, 'self')]);
    const flat = flatten(roots);
    expect(flat).toHaveLength(3);
    expect(flat.find((n) => n.comment.id === 'y')!.depth).toBe(1);
    expect(roots.map((n) => n.comment.id)).toEqual(['x', 'self']);
    expect(roots.every((n) => n.orphan)).toBe(true);
  });

  it('ties on createdAt break by id; parents on another proposal do not adopt', () => {
    const roots = buildThreads([c('b', 1, 'a'), c('a', 1), c('z', 2, 'q'), c('q', 1, undefined, H2)]);
    expect(flatten(roots).map((n) => n.comment.id)).toEqual(['a', 'b', 'q', 'z']);
    expect(roots.find((n) => n.comment.id === 'z')!.orphan).toBe(true);
  });

  it('a 10,000-deep reply chain neither overflows the stack nor nests past the cap', () => {
    const chain = Array.from({ length: 10_000 }, (_, i) => c(`n${String(i).padStart(5, '0')}`, i + 1, i ? `n${String(i - 1).padStart(5, '0')}` : undefined));
    const roots = buildThreads(chain.reverse());
    const flat = flatten(roots);
    expect(flat).toHaveLength(10_000);
    expect(Math.max(...flat.map((n) => n.depth))).toBe(MAX_THREAD_DEPTH);
    expect(flat.map((n) => n.comment.createdAt)).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
    expect(ancestors(roots, 'n09999')).toHaveLength(MAX_THREAD_DEPTH);
    const vis = visibleSubtrees(roots, (x) => x.id === 'n09999');
    expect(vis.get('n00000')).toBe(true);
    expect(visibleSubtrees(roots, () => false).get('n00000')).toBe(false);
  });

  it('duplicate ids are kept once', () => {
    expect(flatten(buildThreads([c('a', 1), c('a', 1)]))).toHaveLength(1);
  });
});

describe('moderation', () => {
  const block = (ownerId: string, target: string, kind: number, reason?: string) => ({ id: `${ownerId}-${target}`, ownerId, target, kind, ...(reason ? { reason } : {}) });
  it('hides by author or by document, from every subscribed list, and remembers the user\'s own blocks', () => {
    const idx = buildHideIndex([
      { source: 'default', ownerId: MOD, name: 'govhub moderation', blocks: [block(MOD, BOB, 1, 'spam')] },
      { source: 'mine', ownerId: ALICE, name: 'my blocks', blocks: [block(ALICE, 'DOC1', 2)] },
      { source: 'subscription', ownerId: ALICE, name: 'forged', blocks: [block(BOB, ALICE, 1)] },
      { source: 'subscription', ownerId: BOB, name: 'odd kinds', blocks: [block(BOB, ALICE, 9)] },
    ]);
    expect(idx.size).toBe(2);
    expect(idx.reasons({ id: 'X', ownerId: BOB })).toEqual([expect.objectContaining({ list: 'govhub moderation', kind: 'identity', reason: 'spam' })]);
    expect(idx.reasons({ id: 'DOC1', ownerId: ALICE })).toEqual([expect.objectContaining({ source: 'mine', kind: 'document' })]);
    expect(idx.reasons({ id: 'Y', ownerId: ALICE })).toEqual([]);
    expect(idx.mine('DOC1')?.ownerId).toBe(ALICE);
    expect(idx.identityHidden(BOB)).toBe(true);
  });

  it('comment filter: everyone until badges are live; "recommended" keeps the owner and badge holders', () => {
    expect(defaultFilter(false)).toBe('all');
    expect(defaultFilter(true)).toBe('recommended');
    const ctx = { owner: ALICE, badged: (o: string) => o === MOD };
    expect(passesFilter({ ownerId: BOB }, 'all', ctx)).toBe(true);
    expect(passesFilter({ ownerId: BOB }, 'recommended', ctx)).toBe(false);
    expect(passesFilter({ ownerId: ALICE }, 'recommended', ctx)).toBe(true);
    expect(passesFilter({ ownerId: MOD }, 'recommended', ctx)).toBe(true);
    expect(passesFilter({ ownerId: ALICE }, 'recommended', { owner: null, badged: () => false })).toBe(false);
  });
});

describe('cost estimates', () => {
  it('match the measured points and grow with size', () => {
    expect(commentCost(280)).toBe(56_175_700);
    expect(commentCost(5000)).toBe(178_395_000);
    expect(commentCost(640)).toBeGreaterThan(commentCost(280));
    expect(commentCost(1)).toBeGreaterThan(0);
    expect(COSTS.reactionCreate / 1e11).toBeCloseTo(0.0005, 4);
    expect(COSTS.reactionFlip / 1e11).toBeCloseTo(0.00003, 5);
    expect(postCost(15_360)).toBeGreaterThan(480_000_000);
    expect(postCost(4000, 1500)).toBeLessThan(postCost(4000));
  });
});
