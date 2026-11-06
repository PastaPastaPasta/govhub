import { describe, expect, it } from 'vitest';
import { isNetworkReason, onlyUnreached, unfinishedReason } from './netError.ts';

describe('why a check did not finish, in words', () => {
  it('network and node failures become one plain sentence', () => {
    for (const raw of ['Failed to fetch', 'TypeError: NetworkError when attempting to fetch resource.', 'node list timeout', 'node source returned no usable nodes', 'all 4 node attempts failed: fetch failed', 'HTTP 503']) {
      expect(unfinishedReason(raw)).toBe("this browser couldn't reach the Dash network's nodes just now");
      expect(isNetworkReason(raw)).toBe(true);
    }
    expect(unfinishedReason(new Error('node list HTTP 429'))).toBe('the Dash network nodes asked this browser to slow down');
    expect(unfinishedReason('gov-bridge unreachable: Load failed')).toBe("this browser couldn't reach the governance data service just now");
    expect(unfinishedReason('1,429 headers checked; ChainLock signature invalid')).toBe('1,429 headers checked; ChainLock signature invalid');
  });
  it("anything else keeps its own text: a proof that didn't check out may matter", () => {
    expect(unfinishedReason('pin-conflict: block 100 hash differs')).toBe('pin-conflict: block 100 hash differs');
    expect(isNetworkReason('ChainLock signature invalid')).toBe(false);
  });
  it('tells a network-only result from one that says something about the proposal', () => {
    expect(onlyUnreached(`The chain couldn't be checked: ${unfinishedReason('Failed to fetch')}`)).toBe(true);
    expect(onlyUnreached('Mismatch: the signed votes the governance data service served contradict the Platform tally for block 1')).toBe(false);
    expect(onlyUnreached("Couldn't verify the submission fee (every DAPI node asked answered NOT_FOUND)")).toBe(false);
    expect(onlyUnreached(null)).toBe(false);
  });
});
