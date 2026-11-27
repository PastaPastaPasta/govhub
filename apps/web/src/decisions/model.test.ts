import { describe, expect, it } from 'vitest';
import { choicePhase, editableUntil, linkUrl, meetsThreshold, parsePollVoteKey, pollDiscussionKey, pollVoteKey, requiredPower, totalVotingPower, yesNoOutlook, yesNoPhase, type ChoicePoll, type YesNoPoll, type YesNoState } from './model.ts';

const D = 86_400_000;
const ID = 'Bx4sgMPNXuZxZwnHa42sT7NKvzZsMpywSX9zDiYp69bK';
const poll = (over: Partial<YesNoPoll> = {}): YesNoPoll => ({ kind: 'yn', id: ID, ownerId: ID, title: 't', description: 'd', url: null, passPercent: 60, minimumTurnoutPercent: 10, endDate: 30 * D, createdAt: 0, updatedAt: 0, revision: 1, ...over });
const open = (yes: number, no: number, abstain = 0): YesNoState => ({ status: 'open', tally: { yes, no, abstain }, result: null });

describe('the yes/no rule', () => {
  it('passes only strictly above the pass percent of yes and no, abstain on neither side', () => {
    expect(meetsThreshold({ yes: 6, no: 4 }, 60)).toBe(false);
    expect(meetsThreshold({ yes: 61, no: 39 }, 60)).toBe(true);
    // at 50 a tie fails
    expect(meetsThreshold({ yes: 5, no: 5 }, 50)).toBe(false);
    expect(meetsThreshold({ yes: 0, no: 0 }, 50)).toBe(false);
  });

  it('needs the turnout share of the voting power, rounded up', () => {
    expect(requiredPower(244, 10)).toBe(25);
    expect(requiredPower(4312, 0)).toBe(0);
    expect(requiredPower(100, 50)).toBe(50);
  });

  it('counts masternodes 1, evonodes 4, banned ones not at all', () => {
    expect(totalVotingPower([{ isValid: true, nType: 0 }, { isValid: true, nType: 1 }, { isValid: false, nType: 1 }])).toBe(5);
  });

  it('says whether a poll is passing, and when the turnout cannot be told', () => {
    expect(yesNoOutlook(poll(), open(20, 4), 200)).toMatchObject({ meetsThreshold: true, required: 20, meetsTurnout: true, passing: true, requiredIsFinal: false });
    expect(yesNoOutlook(poll(), open(10, 4), 200)).toMatchObject({ meetsThreshold: true, meetsTurnout: false, passing: false });
    expect(yesNoOutlook(poll(), open(10, 10), 200)).toMatchObject({ meetsThreshold: false, passing: false });
    // no masternode list (another profile): unknown, unless there is no minimum
    expect(yesNoOutlook(poll(), open(10, 1), null)).toMatchObject({ required: null, meetsTurnout: null, passing: null });
    expect(yesNoOutlook(poll({ minimumTurnoutPercent: 0 }), open(10, 1), null)).toMatchObject({ required: 0, passing: true });
    // finished: Platform's recorded result and requirement win
    const done: YesNoState = { status: 'finished', tally: { yes: 3, no: 1, abstain: 0 }, result: { passed: false, required: 30, at: 5 } };
    expect(yesNoOutlook(poll(), done, 10)).toMatchObject({ required: 30, requiredIsFinal: true, passing: false });
  });
});

describe('phases', () => {
  it('a yes/no poll is open, closing past its end, then ended once Platform recorded it', () => {
    expect(yesNoPhase(poll(), open(0, 0), 1)).toBe('open');
    expect(yesNoPhase(poll(), open(0, 0), 31 * D)).toBe('closing');
    expect(yesNoPhase(poll(), { status: 'finished', tally: { yes: 0, no: 0, abstain: 0 }, result: { passed: false, required: 0, at: null } }, 1)).toBe('ended');
  });

  it('a multiple choice poll waits for a choice, runs to its contest end, then ends', () => {
    const s = (n: number, ended = false) => ({ choices: Array.from({ length: n }, (_, i) => ({ id: String(i), votes: 0 })), abstain: 0, none: 0, total: 0, result: ended ? { keptId: null, at: 1 } : null });
    expect(choicePhase(s(0), null, 5)).toBe('nochoices');
    expect(choicePhase(s(2), 10, 5)).toBe('open');
    expect(choicePhase(s(2), 10, 11)).toBe('closing');
    expect(choicePhase(s(2, true), null, 11)).toBe('ended');
  });

  it('text is editable for a day, or a fifth of the run; a multiple choice poll for two hours', () => {
    expect(editableUntil(poll({ createdAt: 0, endDate: 14 * D }))).toBe(D);
    expect(editableUntil(poll({ createdAt: 0, endDate: 4 * D }))).toBe((4 * D) / 5);
    const mc: ChoicePoll = { kind: 'mc', id: ID, ownerId: ID, title: 't', url: null, description: null, open: true, createdAt: 100, updatedAt: 100, revision: 1 };
    expect(editableUntil(mc)).toBe(100 + 2 * 3_600_000);
  });
});

describe('keys and links', () => {
  it('a poll vote key never looks like a username label', () => {
    expect(parsePollVoteKey(pollVoteKey('yn', ID))).toEqual({ kind: 'yn', id: ID });
    expect(parsePollVoteKey(pollVoteKey('mc', ID))).toEqual({ kind: 'mc', id: ID });
    expect(parsePollVoteKey('a1pha')).toBeNull();
    expect(parsePollVoteKey('yn:not-an-id')).toBeNull();
  });

  it('the discussion key is fixed (it must never change) and differs per poll', () => {
    expect(pollDiscussionKey(ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(pollDiscussionKey(ID)).toBe(pollDiscussionKey(ID));
    expect(pollDiscussionKey(ID)).not.toBe(pollDiscussionKey('6Gne8CbK4x4cYz1nzpk7hpXS5PuCELMeURkeEfrJjbtj'));
  });

  it('links only http(s) urls (Platform takes any URI)', () => {
    expect(linkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(linkUrl('javascript:alert(1)')).toBeNull();
    expect(linkUrl('data:text/html,x')).toBeNull();
    expect(linkUrl('not a url')).toBeNull();
    expect(linkUrl(null)).toBeNull();
  });
});

describe('the leading choice', async () => {
  const { choiceLead } = await import('./ui.tsx');
  const s = (votes: number[]) => ({ choices: votes.map((v, i) => ({ id: `c${i}`, title: `C${i}`, votes: v })), abstain: 0, none: 0, total: votes.reduce((a, b) => a + b, 0), result: null });
  it('names a leader only when it is ahead: Platform breaks ties by the earliest choice, which the state does not say', () => {
    expect(choiceLead(s([3, 1]))).toBe('C0 leads with 75%');
    expect(choiceLead(s([2, 2]))).toBe('Tied at 50%');
    expect(choiceLead(s([]))).toBe('Waiting for its first choice');
  });
});
