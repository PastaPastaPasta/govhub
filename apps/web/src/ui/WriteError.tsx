// A failed write as the user sees it: the message, and a Top up button when the reason is the identity's balance.
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

/** Shown, before anything is signed, when the balance is under what `what` needs available (`needed` credits: the fee, or the up-front requirement). */
export function LowBalance({ what, balance, needed }: { what: string; balance: bigint | null; needed: number }) {
  const { openSheet } = useAuth();
  if (balance === null) return null;
  return (
    <p className="error small" data-testid="low-balance">
      Your balance is {formatCredits(balance)}, and {what} needs about {formatCredits(needed, true)} available. Top up the identity first.{' '}
      <button type="button" className="btn btn-s" data-testid="low-balance-topup" onClick={() => openSheet('topup')}>
        Top up
      </button>
    </p>
  );
}
