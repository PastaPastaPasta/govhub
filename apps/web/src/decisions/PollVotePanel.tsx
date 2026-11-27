// Masternode voting on one poll: the contest vote panel (contests/VotePanel.tsx) with a poll's answers. Signed in this browser with
// each masternode's voting key and sent straight to Platform, like a contest vote; the votes wait in the same list, since a masternode
// signs both as the same voter identity.
import { EVONODE_WEIGHT } from '@govhub/verify';
import { useCallback, useMemo } from 'react';
import { MasternodeVotePanel, type VoteTarget } from '../contests/VotePanel.tsx';
import type { Choice } from '../contests/vote.ts';
import { VOTE_CHANGES } from '../contests/model.ts';
import { pollVoteKey, type ChoiceState, type Poll } from './model.ts';
import { choiceName } from './ui.tsx';
import { useDecisionSource } from './useDecisions.ts';

export function PollVotePanel({ poll, state, endsAt }: { poll: Poll; state: ChoiceState | null; endsAt: number | null }) {
  const src = useDecisionSource();
  const { kind, id } = poll;
  const current = useCallback(async (mns: readonly { proTxHash: string }[]) => src.votesOf(kind, id, mns.map((m) => m.proTxHash)), [src, kind, id]);
  const prepare = useCallback(() => src.signer(kind, id), [src, kind, id]);
  const choiceKey = state ? state.choices.map((c) => `${c.id}:${c.title ?? ''}`).join(',') : '';
  const target = useMemo<VoteTarget>(() => {
    const names = new Map((state?.choices ?? []).map((c) => [c.id, choiceName(c)]));
    const common = { key: pollVoteKey(kind, id), things: 'polls', endsAt, current, prepare };
    if (kind === 'yn')
      return {
        ...common,
        options: [
          { c: { kind: 'yes' }, text: 'Yes', sub: 'Counts for yes' },
          { c: { kind: 'no' }, text: 'No', sub: 'Counts for no' },
          { c: { kind: 'abstain' }, text: 'Abstain', sub: 'Counted, but on neither side: not part of the pass share or the turnout' },
        ],
        choiceText(c: Choice) {
          switch (c.kind) {
            case 'yes':
              return 'Yes';
            case 'no':
              return 'No';
            case 'abstain':
              return 'Abstain';
            default:
              return c.kind;
          }
        },
        prompt: 'Choose yes, no or abstain.',
        rules: `Each masternode can vote on a poll up to ${VOTE_CHANGES} times, never twice the same way in a row; its last vote counts. An evonode's vote counts ${EVONODE_WEIGHT} times. Votes are public on Platform.`,
      };
    return {
      ...common,
      options: [
        ...(state?.choices ?? []).map((c) => ({ c: { kind: 'contender', identityId: c.id } as Choice, text: choiceName(c), sub: c.description ?? 'A choice' })),
        { c: { kind: 'abstain' }, text: 'Abstain', sub: 'Counted, but for no choice' },
        { c: { kind: 'lock' }, text: 'None of the choices', sub: 'If these votes outnumber the leading choice, no choice is kept' },
      ],
      choiceText(c: Choice) {
        switch (c.kind) {
          case 'contender':
            return names.get(c.identityId) ?? 'A choice';
          case 'abstain':
            return 'Abstain';
          case 'lock':
            return 'None of the choices';
          default:
            return c.kind;
        }
      },
      prompt: 'Choose an answer, abstain, or none of the choices.',
      rules: `Each masternode can change its vote up to ${VOTE_CHANGES} times; its last vote counts. An evonode's vote counts ${EVONODE_WEIGHT} times. Votes are public on Platform.`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, endsAt, current, prepare, choiceKey]);
  return <MasternodeVotePanel target={target} />;
}
