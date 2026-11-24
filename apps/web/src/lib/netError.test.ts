import { describe, expect, it } from 'vitest';
import { isNetworkReason, isNotYetChecked, isThrottled, notYetChecked, onlyUnreached, retryWhenThrottled, unfinishedReason, workerErrorText } from './netError.ts';

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
  it('a rate refusal reads as "not yet checked", never as a failure', () => {
    expect(isThrottled(new Error(workerErrorText('all 4 node attempts failed: HTTP 429', true)))).toBe(true);
    // only the worker's structured flag counts: the last of several failed attempts may be a 429 after a node whose answer did not
    // check out, and an error's message ends with a node's own words
    for (const raw of ['all 3 node attempts failed: HTTP 429', 'gov-bridge HTTP 429', 'all 4 node attempts failed: fetch failed', 'all 2 node attempts failed: rate limited: x']) {
      expect(isThrottled(raw)).toBe(false);
      expect(isThrottled(workerErrorText(raw, false))).toBe(false);
    }
    expect(isThrottled(workerErrorText('rate limited: a node wrote this', false))).toBe(false);
    expect(workerErrorText('rate limited: a node wrote this', false)).toBe('node said: rate limited: a node wrote this');
    const line = notYetChecked('The vote count');
    expect(line).toMatch(/^The vote count isn't checked in this browser yet/);
    expect(line).not.toMatch(/fail|error|couldn't/i);
    expect(isNotYetChecked(line) && onlyUnreached(line) && isNotYetChecked(notYetChecked('The chain', true))).toBe(true);
    expect(isNotYetChecked("The chain couldn't be checked: proof invalid")).toBe(false);
  });
});

describe('trying a throttled check again later', () => {
  it('waits and retries only while the nodes ask to slow down, then lets the last error stand', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let n = 0;
    await expect(retryWhenThrottled(() => (++n < 3 ? Promise.reject(new Error('rate limited: HTTP 429')) : Promise.resolve(n)), { sleep, delays: [5, 6, 7], onWait: () => {} })).resolves.toBe(3);
    expect(waits).toEqual([5, 6]);

    n = 0;
    await expect(retryWhenThrottled(() => (n++, Promise.reject(new Error('rate limited: HTTP 429'))), { sleep, delays: [1] })).rejects.toThrow('HTTP 429');
    expect(n).toBe(2);

    n = 0;
    await expect(retryWhenThrottled(() => (n++, Promise.reject(new Error('signature invalid'))), { sleep })).rejects.toThrow('signature invalid');
    expect(n).toBe(1);

    n = 0;
    await expect(retryWhenThrottled(() => (n++, Promise.reject(new Error('rate limited: HTTP 429'))), { sleep, live: () => false })).rejects.toThrow('HTTP 429');
    expect(n).toBe(1);

    // nobody waits any more by the time the wait is over: no new attempt
    n = 0;
    let watching = true;
    const leave = async () => void (watching = false);
    await expect(retryWhenThrottled(() => (n++, Promise.reject(new Error('rate limited: HTTP 429'))), { sleep: leave, live: () => watching })).rejects.toThrow('HTTP 429');
    expect(n).toBe(1);
  });
});
