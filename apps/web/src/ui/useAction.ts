// The busy / error bookkeeping every signing form repeats: `run` clears the error, marks busy, and turns a thrown
// error into text fit to show the user. Success handling stays in the callback, after its last await.
import { useCallback, useState } from 'react';
import { errText } from '../lib/format.ts';

export function useAction(): { busy: boolean; error: string | null; run(action: () => Promise<void>): Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
