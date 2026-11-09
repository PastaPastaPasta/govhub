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
 * The account control, in the shell bar's account slot. Signed out: "Sign in" alone (Settings and About are in the footer). Signed in:
 * the identity, which opens the account menu (balance, profile, top-up, passkeys, settings, sign out).
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
        <button type="button" className="account-btn dh-btn dh-btn--quiet" popoverTarget="account-menu" id="session-button" data-testid="session-button">
          <Avatar id={session.identityId} size={22} />
          <span className="account-name">{name ?? shortHash(session.identityId, 4)}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className="account-chevron" aria-hidden="true">
            <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      ) : (
        <button type="button" className="signin-button dh-btn dh-btn--secondary" onClick={openSignIn} aria-label={auth.restoring ? 'Signing in…' : 'Sign in'} title="Sign in" data-compact-label={auth.restoring ? 'Wait…' : 'Log in'} id="session-button" data-testid="session-button">
          <span className="signin-label" aria-hidden="true">{auth.restoring ? 'Signing in…' : 'Sign in'}</span>
        </button>
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
        {session && <Link className="menu-item" to="/polls?seg=mine" onClick={hide}>My polls</Link>}
        {session && item('Edit profile', () => dialog.current?.showModal())}
        {session && auth.session && item('Top up', () => auth.openSheet('topup'))}
        {session && auth.session && item('Add passkey', () => auth.openSheet('passkeys'))}
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
      <label className="dh-field__label">
        Display name
        <input className="dh-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required aria-describedby="name-problem" />
      </label>
      {problem && (
        <p className="error small" id="name-problem" data-testid="name-problem">
          {problem}
        </p>
      )}
      <label className="dh-field__label">
        Picture <span className="small muted">(a small data: image; others see a pattern from your identity otherwise, and web images are never loaded)</span>
        <input className="dh-input" value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={512} spellCheck={false} />
      </label>
      <p className="muted small">Saving costs about {formatCredits(profile ? COSTS.profileReplace : COSTS.profileCreate, true)} from your balance.</p>
      {saved && <p className="notice">Profile saved on Platform.</p>}
      <WriteError error={error} needsTopUp={needsTopUp} onTopUp={onDone} />
      <div className="form-actions">
        <button type="submit" className="btn dh-btn btn-primary dh-btn--primary" disabled={busy || profile === undefined || !name.trim() || !!problem}>
          {busy ? 'Saving…' : profile ? 'Save profile' : 'Create profile'}
        </button>
        <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}
