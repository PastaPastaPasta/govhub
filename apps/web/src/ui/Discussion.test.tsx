// @vitest-environment happy-dom
// F1: under the default "Owner and masternodes" view a reader without a badge keeps seeing their own comment (with a note that others
// using that view don't), and the other authors' comments stay filtered.
import { EMPTY_HIDE_INDEX, type Comment } from '@govhub/forum';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, flush, render, type } from '../test/render.tsx';

const GOV = 'ab'.repeat(32);
const ME = 'MyIdentity1111111111111111111111111111111111';
const BADGED = 'Badged2222222222222222222222222222222222222';
const PLAIN = 'Plain333333333333333333333333333333333333333';
const OWNER = 'Owner444444444444444444444444444444444444444';
const NOW = 1_800_000_000;
const c = (id: string, ownerId: string, body: string, at = NOW * 1000 - 60_000): Comment => ({ id, ownerId, govHash: GOV, body, fmt: 1, createdAt: at });

let stored: Comment[] = [];
let session: { identityId: string } | null = { identityId: ME };
const write = vi.fn(async () => ({ id: 'NewComment5555555555555555555555555555555555', revision: 1 }));
// stable objects: a fresh `forum` on every render would restart the thread read forever
let readGate: Promise<void> | null = null;
const forum = {
  reader: { comments: async () => ((await readGate), { comments: stored, height: 1, truncated: false }), profiles: async () => new Map() },
  names: async () => new Map(),
  prov: () => ({ source: 'platform', height: 1 }),
  ops: { comment: (_g: string, body: string) => ({ action: 'create', type: 'comment', data: { body } }) },
};
const app = { source: { now: () => NOW }, registry: { forum: { moderationIdentityId: 'ModModModModModModModModModModModModModModModModMo' } }, mode: 'live' };
const moderation = { ready: true, index: EMPTY_HIDE_INDEX, lists: [], subs: { lists: [], defaultOff: false }, loading: false };
const badges = { byOwner: new Map([[BADGED, ['govhub']]]), live: true };
vi.mock('../app/context.tsx', () => ({ useApp: () => app }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ forum, session, write, balance: 5_000_000_000n, moderation, reloadModeration: () => {} }) }));
vi.mock('../badge/context.tsx', () => ({ useBadges: () => badges }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: () => {} }) }));
vi.mock('./useReactions.ts', () => ({ useReactions: () => ({ scores: new Map(), vote: async () => {}, error: null }) }));
const { Discussion } = await import('./Discussion.tsx');

beforeEach(() => {
  stored = [c('c1', BADGED, 'from a masternode owner'), c('c2', PLAIN, 'from someone without a badge'), c('c3', OWNER, 'from the proposal owner')];
  session = { identityId: ME };
  write.mockClear();
});

const mount = () =>
  render(
    <MemoryRouter>
      <Discussion govHash={GOV} owner={OWNER} />
    </MemoryRouter>,
  );
const shownTexts = (el: ParentNode) => [...el.querySelectorAll('li.comment:not(.comment-placeholder) .comment-body')].map((n) => n.textContent!.trim());

describe('F1: your own comment stays under the default view', () => {
  it('the default view is "Owner and masternodes" once badges are live; it shows the owner and the badge holder, not the others', async () => {
    const r = await mount();
    await flush();
    expect(shownTexts(r.el).sort()).toEqual(['from a masternode owner', 'from the proposal owner']);
    expect(r.el.querySelector('[data-testid="show-all"]')!.textContent).toMatch(/Show all 1 other comment/);
    await r.unmount();
  });

  it('a comment posted by a reader with no badge is still shown, with the note, and is highlighted', async () => {
    const r = await mount();
    await flush();
    const box = r.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Post comment"]')!;
    await type(box, 'my own words');
    await click(r.el.querySelector<HTMLButtonElement>('form.composer button[type="submit"]')!);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(shownTexts(r.el)).toContain('my own words');
    const mine = r.el.querySelector('#comment-NewComment5555555555555555555555555555555555')!;
    expect(mine.className).toMatch(/comment-new/);
    expect(mine.querySelector('[data-testid="only-you-note"]')!.textContent).toMatch(/Only you see this in the “Owner and masternodes” view\. Readers on “Everyone” see it too/);
    // the other plain comment is still filtered, and the posted note is on the form
    expect(shownTexts(r.el)).not.toContain('from someone without a badge');
    expect(r.el.querySelector('[data-testid="composer-posted"]')).toBeTruthy();
    // the count of "other comments" a reader could add does not include their own
    expect(r.el.querySelector('[data-testid="show-all"]')!.textContent).toMatch(/Show all 1 other comment/);
    await r.unmount();
  });

  it('a comment already on Platform by the same identity shows too, but only the badge holder and owner get no note', async () => {
    stored = [...stored, c('c4', ME, 'written an hour ago')];
    const r = await mount();
    await flush();
    expect(shownTexts(r.el)).toContain('written an hour ago');
    expect(r.el.querySelectorAll('[data-testid="only-you-note"]')).toHaveLength(1);
    expect(r.el.querySelector('#comment-c1 [data-testid="only-you-note"]')).toBeNull();
    await r.unmount();
  });

  it('signed out: nothing of the kind', async () => {
    session = null;
    stored = [...stored, c('c4', ME, 'someone else, as far as this reader knows')];
    const r = await mount();
    await flush();
    expect(shownTexts(r.el)).not.toContain('someone else, as far as this reader knows');
    expect(r.el.querySelector('[data-testid="only-you-note"]')).toBeNull();
    await r.unmount();
  });

  it('a comment posted while the first read is still running is not lost when the read lands', async () => {
    let open!: () => void;
    readGate = new Promise<void>((r) => (open = r));
    const r = await mount();
    await flush();
    const box = r.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Post comment"]')!;
    await type(box, 'posted too early');
    await click(r.el.querySelector<HTMLButtonElement>('form.composer button[type="submit"]')!);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    open();
    readGate = null;
    await flush();
    await flush();
    expect(shownTexts(r.el)).toContain('posted too early');
    await r.unmount();
  });
});
