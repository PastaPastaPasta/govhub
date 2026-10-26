// F1: the "Owner and masternodes" view never hides what the reader wrote.
import { describe, expect, it } from 'vitest';
import { hiddenFromOthers, passesFilter } from '../src/index.ts';

const none = () => false;
const me = 'MyIdentity1111111111111111111111111111111111';
const other = 'OtherIdentity22222222222222222222222222222222';

describe('F1: comment filter and the reader’s own comments', () => {
  it('the recommended view shows the owner and badge holders, and now the viewer', () => {
    expect(passesFilter({ ownerId: other }, 'recommended', { featured: [], badged: none })).toBe(false);
    expect(passesFilter({ ownerId: me }, 'recommended', { featured: [], badged: none })).toBe(false); // no viewer given: as before
    expect(passesFilter({ ownerId: me }, 'recommended', { featured: [], badged: none, viewer: me })).toBe(true);
    expect(passesFilter({ ownerId: other }, 'recommended', { featured: [], badged: none, viewer: me })).toBe(false);
    expect(passesFilter({ ownerId: other }, 'recommended', { featured: [other], badged: none, viewer: me })).toBe(true);
    expect(passesFilter({ ownerId: other }, 'recommended', { featured: [], badged: (id) => id === other, viewer: me })).toBe(true);
    expect(passesFilter({ ownerId: other }, 'all', { featured: [], badged: none })).toBe(true);
  });

  it('signed out (viewer null or empty) nothing extra shows', () => {
    expect(passesFilter({ ownerId: me }, 'recommended', { featured: [], badged: none, viewer: null })).toBe(false);
    expect(passesFilter({ ownerId: '' }, 'recommended', { featured: [], badged: none, viewer: '' })).toBe(false);
  });

  it('hiddenFromOthers: what the view hides from everyone but the author', () => {
    expect(hiddenFromOthers({ ownerId: me }, 'recommended', { featured: [], badged: none })).toBe(true);
    expect(hiddenFromOthers({ ownerId: me }, 'recommended', { featured: [me], badged: none })).toBe(false); // the owner is shown to all
    expect(hiddenFromOthers({ ownerId: me }, 'recommended', { featured: [], badged: (id) => id === me })).toBe(false);
    expect(hiddenFromOthers({ ownerId: me }, 'all', { featured: [], badged: none })).toBe(false);
  });
});
