import { useEffect, useState } from 'react';

export function SlowRead() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  return slow ? <p className="muted small" role="status">Still reading from the network… You can keep browsing while the reads finish.</p> : null;
}
