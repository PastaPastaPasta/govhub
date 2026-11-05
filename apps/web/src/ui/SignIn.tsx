// Topbar identity control. Signed out: opens the sign-in sheet (auth/AuthSheet.tsx: new identity, recovery phrase, passkey, pasted
// key; sample identities in fixture mode). Signed in: identity, balance, profile editing, top-up and passkeys, and sign-out.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from './Link.tsx';
import { cleanName, COSTS, nameProblem, type Profile } from '@govhub/forum';
import { useForum } from '../app/forum.tsx';
import { OPEN_SIGNIN_EVENT, useAuth } from '../auth/context.tsx';
import { formatCredits, shortHash } from '../lib/format.ts';
import { Avatar } from './Identity.tsx';
import { useAction } from './useAction.ts';
import { WriteError } from './WriteError.tsx';

/** Opens the sign-in sheet from anywhere ("Sign in to comment"). */
export const openSignIn = () => window.dispatchEvent(new Event(OPEN_SIGNIN_EVENT));

/**
 * The account control. Signed out: "Sign in" (opens the sheet) and a small menu for settings. Signed in: the identity, which opens
 * the account menu (balance, profile, top-up, passkeys, settings, sign out).
 */
export function SessionControl() {
  const { forum, session, balance } = useForum();
  const auth = useAuth();
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState<string | null>(null);
  const close = () => dialog.current?.close();
  const hide = () => menu.current?.hidePopover?.();
  // Signing out from elsewhere (leaving the page, another network) closes the panels.
  useEffect(() => {
    if (!session) {
      close();
      hide();
      setName(null);
      return;
    }
    let live = true;
    forum.reader.profiles([session.identityId]).then((m) => live && setName(cleanName(m.get(session.identityId)?.displayName ?? '') || null), () => {});
    return () => {
      live = false;
    };
  }, [session, forum]);
  const item = (label: string, onClick: () => void, testId?: string) => (
    <button
      type="button"
      className="menu-item"
      onClick={() => {
        hide();
        onClick();
      }}
      data-testid={testId}
    >
      {label}
    </button>
  );
  return (
    <div className="account">
      {session ? (
        <button type="button" className="account-btn" popoverTarget="account-menu" id="session-button" data-testid="session-button">
          <Avatar id={session.identityId} size={22} />
          <span className="account-name">{name ?? shortHash(session.identityId, 4)}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className="account-chevron" aria-hidden="true">
            <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      ) : (
        <>
          <button type="button" className="btn" onClick={openSignIn} title="Sign in" id="session-button" data-testid="session-button">
            <svg className="signin-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2" /></svg>
            <span className="signin-label">{auth.restoring ? 'Signing in…' : 'Sign in'}</span>
          </button>
          <button type="button" className="icon-btn" popoverTarget="account-menu" aria-label="Account and settings" data-testid="menu-button">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="3.5" r="1.3" fill="currentColor" /><circle cx="9" cy="9" r="1.3" fill="currentColor" /><circle cx="9" cy="14.5" r="1.3" fill="currentColor" />
            </svg>
          </button>
        </>
      )}
      <div ref={menu} id="account-menu" popover="auto" className="account-menu" aria-label="Account and settings">
        {session && (
          <div className="menu-id">
            <p className="menu-name">{name ?? 'Your identity'}</p>
            <p className="small muted break mono-ish" data-testid="session-identity">
              {session.identityId}
            </p>
            <p className="small">
              Balance <b data-testid="session-balance">{balance === null ? 'reading…' : formatCredits(balance)}</b>{' '}
              <span className="muted">(pays for posts and votes on Platform)</span>
            </p>
            <p className="small muted">Signed in with {session.label}. The key stays in memory, shared with your other open Governance tabs: closing the browser (or the last Governance tab) signs you out.</p>
          </div>
        )}
        {session && item('Edit profile', () => dialog.current?.showModal())}
        {session && auth.session && item('Top up', () => auth.openSheet('topup'))}
        {session && auth.session && item('Add passkey', () => auth.openSheet('passkeys'))}
        {!session && item('Sign in or create an account', openSignIn)}
        {session && (
          <Link className="menu-item" to="/masternodes#mn-badge" onClick={hide} data-testid="menu-badge">
            Masternode badge
          </Link>
        )}
        <Link className="menu-item" to="/settings" onClick={hide}>
          Settings
        </Link>
        <Link className="menu-item" to="/about" onClick={hide}>
          About Governance
        </Link>
        {session && item('Sign out', auth.signOut)}
      </div>
      <dialog ref={dialog} className="dialog" aria-labelledby="session-title" onClick={(e) => e.target === dialog.current && close()}>
        <div className="dialog-body">{session && <SessionPanel onDone={close} onSaved={setName} />}</div>
      </dialog>
    </div>
  );
}

function SessionPanel({ onDone, onSaved }: { onDone(): void; onSaved(name: string): void }) {
  const { forum, session, write } = useForum();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const { busy, error, needsTopUp, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!session) return;
    let live = true;
    forum.reader.profiles([session.identityId]).then(
      (m) => {
        if (!live) return;
        const p = m.get(session.identityId) ?? null;
        setProfile(p);
        setName(p?.displayName ?? '');
        setAvatar(p?.avatarUrl ?? '');
      },
      () => live && setProfile(null),
    );
    return () => {
      live = false;
    };
  }, [forum, session]);
  if (!session) return null;
  // Invisible or text-direction characters and badge text are refused (D-035): they let a name pass for another or for a label.
  const problem = name.trim() ? nameProblem(name) : null;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setSaved(false);
    void run(async () => {
      const r = await write(forum.ops.profile({ displayName: name, ...(profile?.about ? { about: profile.about } : {}), avatarUrl: avatar }, profile ?? undefined));
      setProfile({ id: r.id, ownerId: session.identityId, revision: r.revision ?? 1, displayName: name.trim(), ...(avatar.trim() ? { avatarUrl: avatar.trim() } : {}) });
      onSaved(name.trim());
      setSaved(true);
    });
  };
  return (
    <form className="form" onSubmit={save}>
      <h2 id="session-title">Your profile</h2>
      <p className="small muted">Your name and picture next to your comments. Anyone can read them; they're stored on Dash Platform.</p>
      <label>
        Display name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required aria-describedby="name-problem" />
      </label>
      {problem && (
        <p className="error small" id="name-problem" data-testid="name-problem">
          {problem}
        </p>
      )}
      <label>
        Picture <span className="small muted">(a small data: image; others see a pattern from your identity otherwise, and web images are never loaded)</span>
        <input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={512} spellCheck={false} />
      </label>
      <p className="muted small">Saving costs about {formatCredits(profile ? COSTS.profileReplace : COSTS.profileCreate, true)} from your balance.</p>
      {saved && <p className="notice">Profile saved on Platform.</p>}
      <WriteError error={error} needsTopUp={needsTopUp} onTopUp={onDone} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || profile === undefined || !name.trim() || !!problem}>
          {busy ? 'Saving…' : profile ? 'Save profile' : 'Create profile'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}
