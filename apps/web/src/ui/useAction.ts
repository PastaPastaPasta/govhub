// The busy / error bookkeeping every signing form repeats: `run` clears the error, marks busy, and turns a thrown
// error into text fit to show the user. Success handling stays in the callback, after its last await.
// `needsTopUp` is set when the error is the identity's balance being too low (voting/funds.ts): show <WriteError> with it.
import { useCallback, useState } from 'react';
import { errText } from '../lib/format.ts';
import { TopUpError } from '../voting/funds.ts';

export function useAction(): { busy: boolean; error: string | null; needsTopUp: boolean; run(action: () => Promise<void>): Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNeedsTopUp(false);
    try {
      await action();
    } catch (e) {
      setError(errText(e));
      setNeedsTopUp(e instanceof TopUpError);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, needsTopUp, run };
}
