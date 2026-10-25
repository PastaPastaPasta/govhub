// govhub QA fix group F4: names (D-035), claim labels and warnings (D-036), the thread window (D-038), deadlines (D-039).
import { describe, expect, it } from 'vitest';
import { buildThreads, type Comment } from '@govhub/forum';
import { authorLabel, authorText, claimWarning, DeadlineError, rejectedChip, windowRoots, withDeadline } from './social.ts';

const ID = 'CbcdFn5gTa961Gp1YeizVkrcGuVcMgzJavwVryA4bkYH';
const OTHER = 'Dn2H33Z1LCKC2ZSvhrrAUYaSrHs82AN1Zt5ifjzGGmPX';

describe('D-035: author labels', () => {
  it('the DPNS name comes first; the self-chosen name is cleaned; the id is always there', () => {
    expect(authorLabel(ID, { displayName: '\u202Eecila' }, 'bob.dash')).toMatchObject({ dpns: 'bob.dash', name: 'ecila', quoted: false });
    expect(authorLabel(ID, { displayName: 'al\u200Bice' })).toMatchObject({ dpns: null, name: 'alice' });
    expect(authorLabel(ID, { displayName: '\u200B\u200D' }).name).toBeNull();
    expect(authorLabel(ID).shortId).toMatch(/^Cbcd.+bkYH$/);
    expect(authorText(ID, { displayName: 'alice' })).toBe(`alice (${authorLabel(ID).shortId})`);
    expect(authorText(ID, null, 'alice.dash')).toBe('alice.dash');
    expect(authorText(ID)).toBe(ID);
  });

  it('names that imitate a govhub chip are quoted', () => {
    expect(authorLabel(ID, { displayName: 'bob \u2713 proposal owner' }).quoted).toBe(true);
    expect(authorText(ID, { displayName: 'Verified' })).toMatch(/^"Verified" \(/);
    expect(authorLabel(ID, { displayName: 'bob' }).quoted).toBe(false);
  });
});

describe('D-036: claim labels and the warning before paying', () => {
  it('a claim that was never checked is not "Failed verification"', () => {
    expect(rejectedChip('not checked: more than 50 signature claims on this proposal')).toEqual({ text: 'Not checked', bad: false });
    expect(rejectedChip('signature does not verify for yX')).toEqual({ text: 'Failed verification', bad: true });
  });

  it('warns when the current owner holds the same or a stronger method, or the URL names someone who may accept', () => {
    const owner = (identityId: string, method: 1 | 2 | 3 | 4) => ({ identityId, method, detail: '' });
    expect(claimWarning({ owner: owner(OTHER, 2), named: null }, 2, ID)).toMatch(/cannot take over/);
    expect(claimWarning({ owner: owner(OTHER, 2), named: null }, 3, ID)).toMatch(/cannot take over/);
    expect(claimWarning({ owner: owner(ID, 3), named: null }, 3, ID)).toMatch(/^Your earlier claim/);
    expect(claimWarning({ owner: owner(OTHER, 3), named: null }, 2, ID)).toBeNull();
    expect(claimWarning({ owner: owner(OTHER, 4), named: null }, 3, ID)).toBeNull();
    expect(claimWarning({ owner: null, named: null }, 2, ID)).toBeNull();
    expect(claimWarning({ owner: null, named: { identityId: OTHER, accepted: false, url: '' } }, 2, ID)).toMatch(/names identity/);
    expect(claimWarning({ owner: null, named: { identityId: ID, accepted: false, url: '' } }, 2, ID)).toBeNull();
  });
});

describe('D-038: only the newest threads are rendered', () => {
  const c = (i: number, parentId?: string): Comment => ({ id: `c${i}`, ownerId: ID, govHash: 'h', body: `${i}`, fmt: 1, createdAt: i, ...(parentId ? { parentId } : {}) });
  it('keeps whole threads from the newest back to about `limit` comments, counts the older ones, and adds a deep-linked thread', () => {
    const comments = [...Array.from({ length: 1000 }, (_, i) => c(i)), c(1000, 'c999'), c(1001, 'c999')];
    const roots = buildThreads(comments);
    const visible = new Map(comments.map((x) => [x.id, true]));
    const w = windowRoots(roots, visible, 50, null);
    expect(w.roots.map((r) => r.comment.id)).toEqual(Array.from({ length: 48 }, (_, i) => `c${952 + i}`));
    expect(w.older).toBe(1002 - 50);
    const f = windowRoots(roots, visible, 50, 'c3');
    expect(f.roots[0]!.comment.id).toBe('c3');
    expect(f.older).toBe(1002 - 51);
    // threads with nothing shown take no room
    visible.set('c999', false);
    visible.set('c1000', false);
    visible.set('c1001', false);
    expect(windowRoots(roots, visible, 2, null).roots.map((r) => r.comment.id)).toEqual(['c997', 'c998']);
  });

  it('never leaves a gap: once a thread does not fit, older ones wait too', () => {
    const thread = (root: number, replies: number) => [c(root), ...Array.from({ length: replies }, (_, i) => c(root + 1 + i, `c${root}`))];
    const comments = [...thread(0, 9), ...thread(100, 99), ...thread(1000, 149)]; // sizes, newest first: 150, 100, 10
    const w = windowRoots(buildThreads(comments), new Map(comments.map((x) => [x.id, true])), 200, null);
    expect(w.roots.map((r) => r.comment.id)).toEqual(['c1000']);
    expect(w.older).toBe(110);
  });

  it('always keeps at least the newest thread, however large', () => {
    const comments = [c(0), ...Array.from({ length: 300 }, (_, i) => c(i + 1, 'c0'))];
    const w = windowRoots(buildThreads(comments), new Map(comments.map((x) => [x.id, true])), 50, null);
    expect(w.roots).toHaveLength(1);
    expect(w.older).toBe(0);
  });
});

describe('D-039: deadlines', () => {
  it('a promise that never settles becomes a DeadlineError; one that settles in time passes through', async () => {
    await expect(withDeadline(new Promise(() => {}), 20, 'the list')).rejects.toBeInstanceOf(DeadlineError);
    await expect(withDeadline(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
  });
});
