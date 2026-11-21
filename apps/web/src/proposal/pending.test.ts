// The Active list's pending entries: only this browser's real, recently paid proposals that the list does not have yet.
import { describe, expect, it } from 'vitest';
import { newDraft, type DraftLock, type ProposalDraft } from './draft.ts';
import { pendingDrafts } from './Pending.tsx';

const NOW = 1_794_950_000_000;
const lock = (govHash: string, lockedAt = NOW - 600_000): DraftLock =>
  ({ govHash, lockedAt, endEpoch: NOW / 1000 + 86400, name: govHash, superblocks: [], eligible: [] }) as unknown as DraftLock;
const paid = (govHash: string, o: Partial<ProposalDraft> = {}, lockedAt?: number): ProposalDraft => ({
  ...newDraft('testnet'),
  lock: lock(govHash, lockedAt),
  payment: { method: 'core', txid: 'ab'.repeat(32) },
  ...o,
});

describe('pendingDrafts', () => {
  it('shows a paid proposal until the list has it', () => {
    const d = paid('aa');
    expect(pendingDrafts([d], new Set(), NOW)).toEqual([d]);
    expect(pendingDrafts([d], new Set(['aa']), NOW)).toEqual([]);
  });
  it('never a demo draft, an unpaid one, or one paid hours ago (it will not show up by waiting)', () => {
    expect(pendingDrafts([paid('aa', { demo: true })], new Set(), NOW)).toEqual([]);
    expect(pendingDrafts([{ ...paid('bb'), payment: { method: 'core' } }], new Set(), NOW)).toEqual([]);
    expect(pendingDrafts([paid('cc', {}, NOW - 4 * 3600_000)], new Set(), NOW)).toEqual([]);
  });
});
