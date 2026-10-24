// Topbar identity control. Signed out: opens the sign-in sheet (auth/AuthSheet.tsx: new identity, recovery phrase, passkey, pasted
// key; sample identities in fixture mode). Signed in: identity, balance, profile editing, top-up and passkeys, and sign-out.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { COSTS, type Profile } from '@govhub/forum';
import { useForum } from '../app/forum.tsx';
import { OPEN_SIGNIN_EVENT, useAuth } from '../auth/context.tsx';
import { errText, formatCredits, shortHash } from '../lib/format.ts';
import { Avatar } from './Identity.tsx';

/** Opens the sign-in sheet from anywhere ("Sign in to comment"). */
export const openSignIn = () => window.dispatchEvent(new Event(OPEN_SIGNIN_EVENT));

export function SessionControl() {
  const { session } = useForum();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  // Signing out from elsewhere (leaving the page, another network) closes the panel.
  useEffect(() => {
    if (!session) close();
  }, [session]);
  return (
    <>
      <button type="button" className={`btn ${session ? 'btn-quiet session-btn' : 'btn-primary'}`} onClick={() => (session ? dialog.current?.showModal() : openSignIn())} data-testid="session-button">
        {session ? (
          <>
            <Avatar id={session.identityId} size={20} />
            <span className="mono-ish">{shortHash(session.identityId, 4)}</span>
          </>
        ) : (
          'Sign in'
        )}
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby="session-title" onClick={(e) => e.target === dialog.current && close()}>
        <div className="dialog-body">{session && <SessionPanel onDone={close} />}</div>
      </dialog>
    </>
  );
}

function SessionPanel({ onDone }: { onDone(): void }) {
  const { forum, session, balance, signOut, write } = useForum();
  const auth = useAuth();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await write(forum.ops.profile({ displayName: name, ...(profile?.about ? { about: profile.about } : {}), avatarUrl: avatar }, profile ?? undefined));
      setProfile({ id: r.id, ownerId: session.identityId, revision: r.revision ?? 1, displayName: name.trim(), ...(avatar.trim() ? { avatarUrl: avatar.trim() } : {}) });
      setMsg({ ok: true, text: 'Profile saved on Platform.' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={save}>
      <h2 id="session-title">Signed in</h2>
      <dl className="config-summary">
        <div>
          <dt>Identity</dt>
          <dd className="break mono-ish" data-testid="session-identity">
            {session.identityId}
          </dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd data-testid="session-balance">{balance === null ? 'reading…' : formatCredits(balance)}</dd>
        </div>
        <div>
          <dt>Signing with</dt>
          <dd>{session.label}</dd>
        </div>
      </dl>
      <fieldset>
        <legend>Profile</legend>
        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
        </label>
        <label>
          Avatar URL <span className="small">(others see an identicon unless it is a small data: image; remote images are never loaded)</span>
          <input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={512} spellCheck={false} />
        </label>
        <p className="muted small">
          Saving costs about {formatCredits(profile ? COSTS.profileReplace : COSTS.profileCreate, true)}.
        </p>
        {msg && <p className={msg.ok ? 'notice' : 'error'}>{msg.text}</p>}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy || profile === undefined || !name.trim()}>
            {busy ? 'Saving…' : profile ? 'Update profile' : 'Create profile'}
          </button>
        </div>
      </fieldset>
      {auth.session && (
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onDone();
              auth.openSheet('topup');
            }}
          >
            Top up
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onDone();
              auth.openSheet('passkeys');
            }}
          >
            Add passkey
          </button>
        </div>
      )}
      <p className="muted small">Your key is held in this tab only. Signing out, reloading or closing the tab forgets it.</p>
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            signOut();
            onDone();
          }}
        >
          Sign out
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}
