// Pre-launch polish, the pure parts: the vote badge, plain network errors, Reset keeping the profile, the superblock wording,
// the damaged ?config= link and whether the owner may be called verified.
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@govhub/verify';
import { isTransientError, plainErrorText } from './auth/runtime.ts';
import { DAMAGED_CONFIG, DEFAULT_PROFILE, loadSavedRegistry, profileRegistry, readInlineConfig, resetRegistry, saveRegistry, textToB64url } from './config/registry.ts';
import { GOV_PARAMS, superblockPhrase } from './lib/governance.ts';
import { applyRelayState, describeVote } from './voting/status.ts';
import { signPlanned } from './voting/plan.ts';
import type { WatchedVote } from './voting/pending.ts';
import type { RelayVoteState } from './voting/relay.ts';
import { ownerVerified } from './ui/Ownership.tsx';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('F3: Reset to defaults keeps the profile', () => {
  it('on Testnet it resets to Testnet (and a reload still starts there), not to the default profile', () => {
    const s = memStore();
    const custom = { ...profileRegistry('testnet'), priceFeed: null };
    saveRegistry(custom, s);
    const r = resetRegistry(s, 'testnet');
    expect(r.profile).toBe('testnet');
    expect(JSON.parse(s.m.get('govhub.registry.v2')!)).toEqual({ version: 2, profile: 'testnet', overrides: {} });
    expect(loadSavedRegistry(s).registry.profile).toBe('testnet');
    expect(r.priceFeed).toEqual(profileRegistry('testnet').priceFeed); // the edit is gone
  });
  it('without a profile it is still the app default (DEFAULT_PROFILE itself is untouched by this change)', () => {
    const s = memStore();
    saveRegistry({ ...profileRegistry('testnet') }, s);
    expect(resetRegistry(s).profile).toBe(DEFAULT_PROFILE);
    expect(s.m.size).toBe(0);
  });
  it('on the default profile nothing is left in storage', () => {
    const s = memStore();
    saveRegistry({ ...profileRegistry(DEFAULT_PROFILE), priceFeed: null }, s);
    expect(resetRegistry(s, DEFAULT_PROFILE).profile).toBe(DEFAULT_PROFILE);
    expect(s.m.size).toBe(0);
  });
});

describe('F12: a damaged settings link', () => {
  it('says so, without atob’s words', () => {
    for (const bad of ['%%not-base64%%', 'a', textToB64url('{oops')]) {
      const e = readInlineConfig(bad).errors;
      expect(e).toEqual([DAMAGED_CONFIG]);
    }
    expect(DAMAGED_CONFIG).toMatch(/^This settings link is damaged/);
    expect(DAMAGED_CONFIG).not.toMatch(/atob|decoded|InvalidCharacter/i);
  });
});

describe('F7: the wizard names the network’s superblock', () => {
  it('monthly on mainnet, hourly on testnet', () => {
    expect(superblockPhrase(GOV_PARAMS.mainnet)).toBe('monthly superblock');
    expect(superblockPhrase(GOV_PARAMS.testnet)).toBe('hourly superblock');
    expect(superblockPhrase({ superblockCycle: 1000, blockSeconds: 157.2 })).toMatch(/^superblock \(every ~/);
  });
});

describe('F4: network failures in plain words', () => {
  const raw = ['Failed to prefetch quorums: HTTP request error: error sending request', 'WebAssembly compilation aborted: Network error: Failed to fetch', 'Dapi client error: transport error: connection refused', 'request timed out', 'TypeError: Failed to fetch', 'the bridge answered HTTP 503'];
  it('recognises the transient ones', () => {
    for (const m of raw) expect(isTransientError(new Error(m)), m).toBe(true);
    for (const m of ['Insufficient identity balance', 'Not a valid phrase', 'The identity does not exist', 'document not found 40101', 'Failed to fetch identity: proof verification failed', 'Dapi client error: invalid argument', 'transport error: not found', 'the time outpoint is wrong', 'payload failed the check']) expect(isTransientError(new Error(m)), m).toBe(false);
  });
  it('says what happened and what to do, keeping the technical text after it', () => {
    const t = plainErrorText(new Error(raw[0]), 'Platform');
    expect(t).toMatch(/^Could not reach Platform just now/);
    expect(t).toMatch(/Try again in a moment/);
    expect(t).toContain('Failed to prefetch quorums');
    expect(plainErrorText(new Error('Not a valid phrase'), 'Platform')).toBe('Not a valid phrase');
  });
});

describe('F8: the badge matches the sentence', () => {
  const NOW = 1_792_875_000;
  const R1 = 'https://gov-relay-testnet.dashhq.org';
  const priv = hexToBytes('22'.repeat(32));
  const mn = { proTxHash: 'aa'.repeat(32), collateralTxid: 'bb'.repeat(32), collateralIndex: 62 };
  const fmt = (s: number) => `T${s - NOW}`;
  const vote = (): WatchedVote => ({ ...signPlanned({ mn, govHash: 'cc'.repeat(32), outcome: 2, time: NOW, releaseAt: NOW, notes: [] }, priv, true, 'testnet'), refs: [], status: 'queued', rebroadcasts: 0, signedAt: NOW });
  const state = (over: Partial<RelayVoteState>): RelayVoteState => ({
    id: 'ab'.repeat(16), voteHash: 'cd'.repeat(32), status: 'held', releaseAt: NOW, broadcastAt: null, confirmedAt: null, lastError: null, nextAttemptAt: NOW, holdReason: 'release-time', sameAsCurrent: false, maybeSent: null, ...over,
  });
  it('"going out now" is not "Held by relay"', () => {
    const d = describeVote(applyRelayState(vote(), R1, state({})), NOW, fmt);
    expect(d.line).toBe('Accepted by gov-relay-testnet.dashhq.org, going out now.');
    expect(d.badge).toBe('Going out now');
  });
  it('a vote with something to wait for is still "Held by relay"', () => {
    const d = describeVote(applyRelayState(vote(), R1, state({ releaseAt: NOW + 600, nextAttemptAt: NOW + 600 })), NOW, fmt);
    expect(d).toMatchObject({ badge: 'Held by relay', tone: 'wait' });
  });
});

describe('F10: "verified owner" only next to a verified page', () => {
  it('not beside Couldn’t verify, Failed verification or a running check', () => {
    for (const level of ['error', 'failed', 'checking'] as const) expect(ownerVerified(level), level).toBe(false);
    for (const level of ['verified', 'partial', 'demo'] as const) expect(ownerVerified(level), level).toBe(true);
  });
});
