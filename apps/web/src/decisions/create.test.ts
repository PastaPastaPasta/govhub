import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { choiceOp, choicePollCost, choicePollOp, choicePollProblems, endDateFor, hasProblems, urlProblem, yesNoOp, yesNoProblems, type YesNoDraft } from './create.ts';
import { DECISIONS_CONTRACT_ID } from './model.ts';

const D = 86_400_000;
const NOW = 1_800_000_000_000;
const draft = (over: Partial<YesNoDraft> = {}): YesNoDraft => ({ title: 'Should we?', description: 'Yes: we do. No: we do not.', url: '', passPercent: 60, minimumTurnoutPercent: 10, days: 14, ...over });

describe('a yes/no poll', () => {
  it('is checked against the contract rule before anything is signed', () => {
    expect(yesNoProblems(draft())).toEqual({});
    expect(Object.keys(yesNoProblems(draft({ title: ' ', description: '', passPercent: 49, minimumTurnoutPercent: 51, days: 6 }))).sort()).toEqual(['days', 'description', 'minimumTurnoutPercent', 'passPercent', 'title']);
    expect(yesNoProblems(draft({ title: 'x'.repeat(129) })).title).toMatch(/128/);
    expect(yesNoProblems(draft({ passPercent: 80, minimumTurnoutPercent: 50, days: 28 }))).toEqual({});
  });

  it('ends inside Platform’s one-to-four-week window, an hour from its edges', () => {
    expect(endDateFor(14, NOW)).toBe(NOW + 14 * D);
    expect(endDateFor(7, NOW)).toBe(NOW + 7 * D + 3_600_000);
    expect(endDateFor(28, NOW)).toBe(NOW + 28 * D - 3_600_000);
  });

  it('writes the proposal document with its fund stated', () => {
    const op = yesNoOp(draft({ title: '  Should   we? ', url: 'https://x.org/a' }), NOW);
    expect(op).toEqual({
      action: 'create',
      contractId: DECISIONS_CONTRACT_ID,
      type: 'proposal',
      data: { title: 'Should we?', description: 'Yes: we do. No: we do not.', url: 'https://x.org/a', passPercent: 60, minimumTurnoutPercent: 10, endDate: NOW + 14 * D },
      fund: true,
    });
    expect('url' in yesNoOp(draft(), NOW).data).toBe(false);
  });
});

describe('a multiple choice poll', () => {
  it('needs a url and, when only the asker may add choices, two of them', () => {
    const p = choicePollProblems({ title: 'Which?', url: '', open: false, choices: [{ title: 'A', description: '' }] });
    expect(p.url).toBeTruthy();
    expect(p.count).toMatch(/two/);
    expect(hasProblems(choicePollProblems({ title: 'Which?', url: 'https://x.org', open: true, choices: [{ title: 'A', description: '' }, { title: '', description: '' }] }))).toBe(false);
    expect(urlProblem('ftp://x.org', true)).toMatch(/http/);
  });

  it('costs 0.2 DASH and 0.1 DASH a choice', () => {
    expect(choicePollCost(0)).toBe(20_000_000);
    expect(choicePollCost(3)).toBe(50_000_000);
  });

  it('writes the proposal and each choice, the choice naming the proposal by its id bytes', () => {
    expect(choicePollOp({ title: 'Which?', url: 'https://x.org', open: true, choices: [] }).data).toEqual({ title: 'Which?', url: 'https://x.org', open: true });
    const id = '6Gne8CbK4x4cYz1nzpk7hpXS5PuCELMeURkeEfrJjbtj';
    const op = choiceOp(id, { title: 'Green', description: '' });
    expect(op.type).toBe('choice');
    expect(op.fund).toBe(true);
    expect(op.data.proposalId).toEqual(base58.decode(id));
    expect('description' in op.data).toBe(false);
  });
});
