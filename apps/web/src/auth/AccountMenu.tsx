// Header control: "Sign in" when signed out; otherwise the account menu (identity id, balance, top-up, passkeys, sign out).
import { useEffect, useRef } from 'react';
import { useAuth } from './context.tsx';
import { formatCredits } from './runtime.ts';

const SOURCE = { seed: 'recovery phrase', key: 'pasted key', passkey: 'passkey' } as const;
const LEVEL = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM'];

export function AccountMenu() {
  const { session, balance, openSheet, signOut, refreshBalance } = useAuth();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // close the menu on outside clicks
    const h = (e: MouseEvent) => ref.current?.open && !ref.current.contains(e.target as Node) && (ref.current.open = false);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, []);
  if (!session) {
    return (
      <button type="button" className="btn btn-primary auth-btn" onClick={() => openSheet('choose')}>
        Sign in
      </button>
    );
  }
  const act = (f: () => void) => () => {
    if (ref.current) ref.current.open = false;
    f();
  };
  return (
    <details className="account" ref={ref} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && refreshBalance()}>
      <summary className="btn" data-testid="account-button">
        <span className="account-dot" aria-hidden="true" />
        {session.identityId.slice(0, 6)}…
      </summary>
      <div className="account-pop" role="menu">
        <dl className="account-facts">
          <div>
            <dt>Identity</dt>
            <dd className="break mono-ish" data-testid="identity-id">
              {session.identityId}
            </dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd data-testid="balance">{balance === null ? '…' : formatCredits(balance)}</dd>
          </div>
          <div>
            <dt>Signed in with</dt>
            <dd>
              {SOURCE[session.source]}, key {session.keyId} ({LEVEL[session.securityLevel]})
            </dd>
          </div>
        </dl>
        <div className="account-actions">
          <button type="button" className="btn" role="menuitem" onClick={act(() => openSheet('topup'))}>
            Top up
          </button>
          <button type="button" className="btn" role="menuitem" onClick={act(() => openSheet('passkeys'))}>
            Add passkey
          </button>
          <button type="button" className="btn btn-quiet" role="menuitem" onClick={act(signOut)}>
            Sign out
          </button>
        </div>
        <p className="muted small">Your key is held in this tab only. Signing out or closing the tab forgets it.</p>
      </div>
    </details>
  );
}
