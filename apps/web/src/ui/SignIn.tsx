// Topbar identity control. Signed out: a dialog with the dev key-paste sign-in (dev builds only) or, in fixture
// mode, sample identities. Signed in: identity, balance, profile editing and sign-out.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { COSTS, type Profile } from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { FIXTURE_IDS } from '../data/fixtureForum.ts';
import { errText, formatCredits, shortHash } from '../lib/format.ts';
import { DEV_SIGNIN_ENABLED, devKeySession } from '../session/devKey.ts';
import { fixtureSession } from '../session/fixture.ts';
import { Avatar } from './Identity.tsx';
import { useAction } from './useAction.ts';

const OPEN_EVENT = 'govhub:signin';
/** Opens the sign-in dialog from anywhere ("Sign in to comment"). */
export const openSignIn = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function SessionControl() {
  const { session } = useForum();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const open = () => dialog.current?.showModal();
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
  const close = () => dialog.current?.close();
  return (
    <>
      <button type="button" className={`btn ${session ? 'btn-quiet session-btn' : 'btn-primary'}`} onClick={() => dialog.current?.showModal()} data-testid="session-button">
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
        <div className="dialog-body">{session ? <SessionPanel onDone={close} /> : <SignInPanel onDone={close} />}</div>
      </dialog>
    </>
  );
}

function SignInPanel({ onDone }: { onDone(): void }) {
  const { mode, registry } = useApp();
  const { forum, signIn } = useForum();
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const { busy, error, run } = useAction();

  if (mode === 'fixtures' && forum.store) {
    const store = forum.store;
    const pick = (identityId: string, label: string) => {
      signIn(fixtureSession(store, identityId, label));
      onDone();
    };
    return (
      <>
        <h2 id="session-title">Sign in to a sample identity</h2>
        <p className="muted small">Fixture mode: writes go into this tab's sample data and cost pretend credits from a 0.003 DASH starter.</p>
        <div className="signin-picks">
          <button type="button" className="btn" onClick={() => pick(FIXTURE_IDS.alice, 'fixture identity')}>
            Alice
          </button>
          <button type="button" className="btn" onClick={() => pick(FIXTURE_IDS.growth, 'fixture identity')}>
            Dash Growth team (owns dash-growth-q4-2026)
          </button>
          <button type="button" className="btn" onClick={() => pick(registry.forum.moderationIdentityId, 'fixture moderator')}>
            Moderator (default block list)
          </button>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onDone}>
            Cancel
          </button>
        </div>
      </>
    );
  }

  if (!DEV_SIGNIN_ENABLED) {
    return (
      <>
        <h2 id="session-title">Sign in</h2>
        <p>Sign-in with a Dash seed, a passkey or the central login is not part of this build yet.</p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onDone}>
            Close
          </button>
        </div>
      </>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      signIn(await devKeySession(registry, id.trim(), secret));
      setSecret('');
      onDone();
    });
  };
  return (
    <form className="form signin-form" onSubmit={submit}>
      <h2 id="session-title">Developer sign-in</h2>
      <p className="notice-warn small">
        Development builds only. Paste a <b>{registry.platformNetwork}</b> identity and the private key of one of its HIGH or CRITICAL authentication keys. The key stays in
        this tab's memory and is gone on reload. Never paste a mainnet key you care about.
      </p>
      <label>
        Identity id
        <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} name="identity" required />
      </label>
      <label>
        Private key (WIF or hex)
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} name="key" required />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking the key…' : 'Sign in'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SessionPanel({ onDone }: { onDone(): void }) {
  const { forum, session, balance, signOut, write } = useForum();
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
