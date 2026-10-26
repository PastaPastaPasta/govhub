import { hexToBytes } from '@govhub/auth';
import { describe, expect, it } from 'vitest';
import { dueVotes, loadHeld, releaseTimes, respreadOverdue, retryDelayMs, saveHeld, spreadWindow, storageKey, type HeldVote } from './held.ts';
import { choiceFromJson, classifySendError, sameChoice, voterIdOf } from './vote.ts';

describe('voter identity', () => {
  it('is SHA-256(proTxHash ‖ voting key hash), as Platform derives it', () => {
    // testnet masternode-12: Platform accepted a vote signed by this voter (2026-10-26); only public data here
    const proTx = '0e5ed7d2e33f2e0b221648c3f99735afd6762270ff6a35978df389a7f82976d9';
    const keyHash = hexToBytes('7d0138cea5135b7e0d5ff96c57483eb5c155f144');
    expect(voterIdOf(proTx, keyHash)).toBe('397LTZugipEc6L6ZcW8vMPuE3mDXsNpRGHM8aFkNnHpx');
    expect(() => voterIdOf('ab', keyHash)).toThrow();
  });
});

describe('choices', () => {
  it('reads Platform JSON and compares', () => {
    expect(choiceFromJson({ $type: 'towardsIdentity', identity: 'X' })).toEqual({ kind: 'contender', identityId: 'X' });
    expect(choiceFromJson({ $type: 'lock' })).toEqual({ kind: 'lock' });
    expect(choiceFromJson({ $type: 'abstain' })).toEqual({ kind: 'abstain' });
    expect(choiceFromJson({ $type: 'other' })).toBeNull();
    expect(sameChoice({ kind: 'contender', identityId: 'A' }, { kind: 'contender', identityId: 'A' })).toBe(true);
    expect(sameChoice({ kind: 'contender', identityId: 'A' }, { kind: 'contender', identityId: 'B' })).toBe(false);
    expect(sameChoice({ kind: 'lock' }, { kind: 'abstain' })).toBe(false);
  });
});

describe('Platform answers', () => {
  const err = (code: number, message = 'x') => ({ code, message });
  it('maps the voting errors to final, same, check or retry', () => {
    expect(classifySendError(err(40302))).toEqual({ kind: 'final', text: 'Voting on this name had closed.' });
    expect(classifySendError(err(40303)).kind).toBe('final');
    expect(classifySendError(err(40304)).kind).toBe('same');
    expect(classifySendError(err(40305)).text).toMatch(/voting key changed/);
    expect(classifySendError(err(40204)).kind).toBe('check');
    expect(classifySendError(err(20002)).kind).toBe('final');
    expect(classifySendError(new Error('timeout'))).toEqual({ kind: 'retry', text: 'timeout' });
    // a code only in the message (some SDK errors carry none)
    expect(classifySendError({ message: 'Failed to broadcast: 40302 not available' }).kind).toBe('final');
  });
});

const vote = (over: Partial<HeldVote> = {}): HeldVote => ({
  id: 'v1',
  network: 'testnet',
  label: 'a1pha',
  proTxHash: 'p1',
  voterId: 'V1',
  weight: 1,
  choice: { kind: 'lock' },
  st: 'AA==',
  nonce: '1',
  mode: 'spread',
  releaseAt: 1000,
  endsAt: null,
  status: 'waiting',
  tries: 0,
  ...over,
});

describe('held votes', () => {
  const H = 3_600_000;
  it('spreads within the window, leaving the margin before the close', () => {
    const now = 1_000_000_000_000;
    expect(spreadWindow(now, null, 'mainnet')).toBeNull();
    expect(spreadWindow(now, now + H, 'mainnet')).toBeNull(); // mainnet keeps 2 h free
    const w = spreadWindow(now, now + 10 * H, 'mainnet')!;
    expect(w).toEqual({ earliest: now + 60_000, latest: now + 8 * H });
    let x = 7;
    const lcg = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
    const times = releaseTimes(3, w, lcg);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(w.earliest);
      expect(t).toBeLessThanOrEqual(w.latest);
    }
    expect(new Set(times).size).toBe(3);
    expect(spreadWindow(now, now + 20 * 60_000, 'testnet')).toEqual({ earliest: now + 60_000, latest: now + 10 * 60_000 });
  });

  it('gives overdue spread-out votes a new time soon, never past the close, and leaves "now" votes due', () => {
    const now = 10_000_000;
    const list = [vote({ id: 'old', releaseAt: now - 3 * 60_000 }), vote({ id: 'fresh', releaseAt: now - 30_000 }), vote({ id: 'now', mode: 'now', releaseAt: now - 3_600_000 }), vote({ id: 'closing', releaseAt: 0, endsAt: now + 120_000 })];
    const out = new Map(respreadOverdue(list, now, () => 0x7fffffff).map((v) => [v.id, v.releaseAt]));
    expect(out.get('old')).toBeGreaterThanOrEqual(now);
    expect(out.get('old')).toBeLessThanOrEqual(now + 15 * 60_000);
    expect(out.get('fresh')).toBe(now - 30_000);
    expect(out.get('now')).toBe(now - 3_600_000);
    expect(out.get('closing')).toBeLessThanOrEqual(now + 60_000);
  });

  it('is due when its time came and its retry wait is over, earliest first', () => {
    const list = [vote({ id: 'b', releaseAt: 20 }), vote({ id: 'a', releaseAt: 10 }), vote({ id: 'later', releaseAt: 99 }), vote({ id: 'retry', releaseAt: 1, nextTryAt: 60 }), vote({ id: 'sent', releaseAt: 1, status: 'sent' })];
    expect(dueVotes(list, 50).map((v) => v.id)).toEqual(['a', 'b']);
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(3)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(300_000);
  });

  it('stores only what is still to send, per network, and resumes an interrupted send', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    saveHeld(store, 'testnet', [vote({ id: 'w' }), vote({ id: 's', status: 'sending' }), vote({ id: 'done', status: 'sent' }), vote({ id: 'main', network: 'mainnet' })]);
    const back = loadHeld(store, 'testnet');
    expect(back.map((v) => [v.id, v.status])).toEqual([
      ['w', 'waiting'],
      ['s', 'waiting'],
    ]);
    expect(loadHeld(store, 'mainnet')).toEqual([]);
    m.set(storageKey('testnet'), JSON.stringify([{ id: 1 }, vote({ id: 'ok' }), 'junk']));
    expect(loadHeld(store, 'testnet').map((v) => v.id)).toEqual(['ok']);
    saveHeld(store, 'testnet', []);
    expect(m.has(storageKey('testnet'))).toBe(false);
  });
});
