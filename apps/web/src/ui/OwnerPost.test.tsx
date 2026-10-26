// @vitest-environment happy-dom
// F10: the owner's description is "written by the verified proposal owner" only while the page's own verdict is not "Couldn't verify".
import { EMPTY_HIDE_INDEX } from '@govhub/forum';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test/render.tsx';

const forum = { session: null, moderation: { ready: true, index: EMPTY_HIDE_INDEX } };
vi.mock('../app/forum.tsx', () => ({ useForum: () => forum }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ registry: { forum: {} }, source: {} }) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: () => {} }) }));
const { OwnerPost } = await import('./Ownership.tsx');

const post = { state: { post: { id: 'P', ownerId: 'O', revision: 1, govHash: 'ab'.repeat(32), title: 'Our plan', chunks: [] }, body: 'The plan in words.' }, set: () => {} } as unknown as Parameters<typeof OwnerPost>[0]['post'];
const byline = async (level: Parameters<typeof OwnerPost>[0]['trustLevel']) => {
  const r = await render(<OwnerPost govHash={'ab'.repeat(32)} ownerId="O" post={post} trustLevel={level} />);
  const t = r.el.querySelector('[data-testid="owner-post-byline"]')!.textContent!;
  await r.unmount();
  return t;
};

describe('F10: "verified owner" wording', () => {
  it('says verified owner next to a verified page', async () => {
    expect(await byline('verified')).toMatch(/^Written by the verified proposal owner/);
  });
  it('does not, next to "Couldn’t verify", "Failed verification" or a check still running', async () => {
    for (const level of ['error', 'failed', 'checking'] as const) {
      const t = await byline(level);
      expect(t, level).not.toMatch(/verified proposal owner/);
      expect(t, level).toMatch(/^Written by the identity that claimed this proposal/);
    }
  });
});
