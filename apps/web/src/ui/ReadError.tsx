// A failed read as the user sees it: plain words, and a Retry that re-runs the load in place (no page reload, so keys that live only in
// this tab's memory survive).
import { isTransientError, plainErrorText } from '../auth/runtime.ts';

export function ReadError({ error, what, lead, onRetry }: { error: string; what: string; lead?: string; onRetry(): void }) {
  const text = plainErrorText(error, what);
  return (
    <div className="error read-error" role="alert" data-testid="read-error">
      <p>{lead ? (isTransientError(error) ? `${lead}. ${text}` : `${lead}: ${text}`) : text}</p>
      <p className="form-actions">
        <button type="button" className="btn btn-s" onClick={onRetry} data-testid="read-retry">
          Retry
        </button>
      </p>
    </div>
  );
}
