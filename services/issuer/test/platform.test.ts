// The issuerKey range read behind keyConflict: paged by epoch, the next page after the HIGHEST epoch seen (the SDK's result map need
// not iterate in epoch order), and a hard cap so a huge or hostile owner fails closed instead of returning a partial list.
import { describe, expect, it } from 'vitest';
import type { IssuerKeyDoc } from '@govhub/badge';
import { ISSUER_KEYS_MAX_PAGES, pageIssuerKeys } from '../src/platform.ts';

const doc = (epoch: number): IssuerKeyDoc => ({ ownerId: new Uint8Array(32), epoch, spki: new Uint8Array(294), keyId: new Uint8Array(32), variant: '', createdAtCoreBlockHeight: 1 });

/** A fake proved range query over the epochs in `have`, answering a page of 100 in a scrambled order. */
function fake(have: number[]) {
  const calls: number[] = [];
  const page = async (from: number) => {
    calls.push(from);
    const hit = have.filter((e) => e >= from).sort((a, b) => a - b).slice(0, 100);
    return hit.reverse().map(doc); // highest first: the last element is NOT the highest epoch
  };
  return { calls, page };
}

describe('pageIssuerKeys', () => {
  it('a short page is the end', async () => {
    const f = fake([5, 6, 9]);
    expect((await pageIssuerKeys(5, f.page)).map((d) => d.epoch).sort((a, b) => a - b)).toEqual([5, 6, 9]);
    expect(f.calls).toEqual([5]);
  });

  it('a full page reads on from after its highest epoch, whatever order the page came in', async () => {
    const have = Array.from({ length: 250 }, (_, i) => 10 + i);
    const f = fake(have);
    const out = await pageIssuerKeys(10, f.page);
    expect(out.map((d) => d.epoch).sort((a, b) => a - b)).toEqual(have);
    expect(f.calls).toEqual([10, 110, 210]);
  });

  it('more than the page cap throws rather than return a partial list', async () => {
    const f = fake(Array.from({ length: ISSUER_KEYS_MAX_PAGES * 100 + 1 }, (_, i) => 1 + i));
    await expect(pageIssuerKeys(1, f.page)).rejects.toThrow(/more than/);
    expect(f.calls).toHaveLength(ISSUER_KEYS_MAX_PAGES);
  });
});
