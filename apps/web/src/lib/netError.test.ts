import { describe, expect, it } from 'vitest';
import { isNetworkReason, unfinishedReason } from './netError.ts';

describe('why a check did not finish, in words', () => {
  it('network and node failures become one plain sentence', () => {
    for (const raw of ['Failed to fetch', 'TypeError: NetworkError when attempting to fetch resource.', 'node list timeout', 'node source returned no usable nodes', 'all 4 node attempts failed: fetch failed', 'gov-bridge unreachable: Load failed', 'HTTP 503']) {
      expect(unfinishedReason(raw)).toBe("this browser couldn't reach the Dash network's nodes just now");
      expect(isNetworkReason(raw)).toBe(true);
    }
    expect(unfinishedReason(new Error('node list HTTP 429'))).toBe('the Dash network nodes asked this browser to slow down');
  });
  it("anything else keeps its own text: a proof that didn't check out may matter", () => {
    expect(unfinishedReason('pin-conflict: block 100 hash differs')).toBe('pin-conflict: block 100 hash differs');
    expect(isNetworkReason('ChainLock signature invalid')).toBe(false);
  });
});
