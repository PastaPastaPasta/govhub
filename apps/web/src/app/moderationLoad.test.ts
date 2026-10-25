// D-039: a block-list read that never answers fails closed after a deadline instead of hanging "Applying block lists...".
import { describe, expect, it } from 'vitest';
import type { Block } from '@govhub/forum';
import { failedText, readModeration, type ListReader } from './moderationLoad.ts';

const MOD = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
const ME = 'CbcdFn5gTa961Gp1YeizVkrcGuVcMgzJavwVryA4bkYH';
const never = <T,>() => new Promise<T>(() => {});
const base = { moderationIdentityId: MOD, moderationName: 'govhub moderation', localSubs: { defaultOff: false, lists: [] }, deadlineMs: 30 };

describe('readModeration', () => {
  it('a hung default list is reported as failed after the deadline; the lists that answered still apply', async () => {
    const mine: Block[] = [];
    const reader: ListReader = { blocks: (c) => (c === 'mod' ? never() : Promise.resolve(mine)), blockSubs: () => Promise.resolve(null) };
    const t = Date.now();
    const r = await readModeration(reader, { ...base, identityId: ME });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.failed).toEqual(['govhub moderation']);
    expect(r.lists.map((l) => l.name)).toEqual(['your blocks']);
    expect(failedText(r.failed)).toBe('The block list govhub moderation could not be read');
  });

  it('a hung subscriptions read falls back to this browser\'s subscriptions; errors still fail closed', async () => {
    const reader: ListReader = { blocks: () => Promise.reject(new Error('grpc')), blockSubs: () => never() };
    const r = await readModeration(reader, { ...base, identityId: ME });
    expect(r.subs).toEqual(base.localSubs);
    expect(r.failed).toEqual(['govhub moderation', 'your blocks']);
    expect(failedText(r.failed)).toMatch(/^The block lists /);
  });
});
