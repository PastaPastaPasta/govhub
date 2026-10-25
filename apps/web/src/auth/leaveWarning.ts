// Asks before the tab closes or reloads while an asset lock is in flight: the lock's IS-lock arrives once, within seconds, and is
// never replayed, so a reload then costs a wait for a ChainLock proof (and a closed tab leaves the funding to be resumed or recovered).
import { useEffect } from 'react';

export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers need it set to show the prompt
    };
    addEventListener('beforeunload', onBeforeUnload);
    return () => removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}
