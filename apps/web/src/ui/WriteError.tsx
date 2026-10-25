// A failed write as the user sees it: the message, and a Top up button when the reason is the identity's balance.
import { upfrontRequired } from '@govhub/forum';
import { useAuth } from '../auth/context.tsx';
import { formatCredits } from '../lib/format.ts';

export function WriteError({ error, needsTopUp = false, onTopUp, inline = false }: { error: string | null; needsTopUp?: boolean; onTopUp?: () => void; inline?: boolean }) {
  const { openSheet } = useAuth();
  if (!error) return null;
  const Tag = inline ? 'span' : 'p'; // inline inside a <span> (the vote buttons)
  return (
    <Tag className="error small" role="alert" data-testid="write-error">
      {error}
      {needsTopUp && (
        <>
          {' '}
          <button
            type="button"
            className="btn btn-s"
            data-testid="write-topup"
            onClick={() => {
              onTopUp?.();
              openSheet('topup');
            }}
          >
            Top up
          </button>
        </>
      )}
    </Tag>
  );
}

/** Shown, before anything is signed, when the balance is under what Platform needs available for a write whose fee is about `fee`. */
export function LowBalance({ what, balance, fee }: { what: string; balance: bigint; fee: number }) {
  const { openSheet } = useAuth();
  return (
    <p className="error small" data-testid="low-balance">
      Your balance ({formatCredits(balance)}) is below the about {formatCredits(upfrontRequired(fee), true)} Platform needs available for {what}. Top up the identity first.{' '}
      <button type="button" className="btn btn-s" data-testid="low-balance-topup" onClick={() => openSheet('topup')}>
        Top up
      </button>
    </p>
  );
}
