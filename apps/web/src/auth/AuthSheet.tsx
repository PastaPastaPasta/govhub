// Sign-in sheet (a modal <dialog>): create a new identity, use an existing recovery phrase, paste a key, or use a passkey; plus the
// signed-in views reached from the account menu (top-up, passkeys). Secrets are held in component state only while a view needs
// them; the session takes ownership of the seed when sign-in completes, and closing the sheet drops the rest.
import {
  addressOf, discardFunding, discoverIdentities, generatePhrase, isValidPhrase, localPasskeys, nextTopUpIndex, normalizePhrase, parseVoucher, pendingFundings, PhraseError,
  redeemVoucher, registrationFundingPath, SeedWallet, signInWithKey, signInWithSeed, toBase64, wipe, type FoundIdentity, type FundingRecord, type PhraseLength,
} from '@govhub/auth';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth, type SheetView } from './context.tsx';
import { FundingPanel } from './FundingPanel.tsx';
import { PasskeySignIn, Passkeys } from './Passkeys.tsx';
import { errorText } from './runtime.ts';

const TITLES: Record<SheetView, string> = {
  choose: 'Sign in to govhub',
  create: 'Create a Dash identity',
  phrase: 'Sign in with a recovery phrase',
  key: 'Sign in with a key',
  passkey: 'Sign in with a passkey',
  topup: 'Top up',
  passkeys: 'Passkeys',
};

export function AuthSheet() {
  const { sheet, closeSheet } = useAuth();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (sheet && !d.open) d.showModal();
    if (!sheet && d.open) d.close();
  }, [sheet]);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby="sheet-title" onClose={closeSheet} onCancel={closeSheet}>
      {sheet && (
        <div className="sheet-body">
          <header className="sheet-head">
            <h2 id="sheet-title">{TITLES[sheet]}</h2>
            <button type="button" className="btn btn-quiet" onClick={closeSheet} aria-label="Close">
              ✕
            </button>
          </header>
          {/* key = view: switching views unmounts the previous one and drops what it held */}
          <SheetContent key={sheet} view={sheet} />
        </div>
      )}
    </dialog>
  );
}

function SheetContent({ view }: { view: SheetView }) {
  switch (view) {
    case 'choose':
      return <Choose />;
    case 'create':
      return <CreateFlow />;
    case 'phrase':
      return <PhraseSignIn />;
    case 'key':
      return <KeySignIn />;
    case 'passkey':
      return <PasskeySignIn />;
    case 'topup':
      return <TopUp />;
    case 'passkeys':
      return <Passkeys />;
  }
}

function Choose() {
  const { openSheet, store, network } = useAuth();
  const [, rerender] = useState(0);
  const pending = pendingFundings(store, network).filter((r) => r.kind === 'create');
  const options: Array<{ v: SheetView; title: string; text: string }> = [
    { v: 'create', title: 'Create a new identity', text: 'A new recovery phrase that DashPay, Dash Evo Tool and Yappr can restore. Fund it with DASH or a faucet voucher.' },
    { v: 'phrase', title: 'I have a recovery phrase', text: 'govhub, DashPay or Dash Evo Tool: 12 or 24 words.' },
    { v: 'passkey', title: 'Use a passkey', text: 'If you added one on another device or browser.' },
    { v: 'key', title: 'Paste a key', text: 'An identity authentication key (HIGH or CRITICAL), WIF or hex.' },
  ];
  return (
    <div className="sheet-choose">
      {pending.length > 0 && (
        <div className="notice-box" role="status">
          <p>
            <b>{pending.length === 1 ? 'An identity setup is' : `${pending.length} identity setups are`} in progress.</b> Enter the recovery phrase to continue one.
          </p>
          <ul className="pending-list">
            {pending.map((r) => (
              <li key={r.key}>
                <span className="mono-ish">{r.address}</span>
                <span className="muted small">{r.deposits.length || r.lock ? 'payment received' : 'no payment yet'}</span>
                {!r.deposits.length && !r.lock && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      discardFunding(store, r.key);
                      rerender((n) => n + 1);
                    }}
                  >
                    Discard
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => openSheet('phrase')}>
            Continue
          </button>
        </div>
      )}
      <ul className="choices">
        {options.map((o) => (
          <li key={o.v}>
            <button type="button" className="choice" onClick={() => openSheet(o.v)}>
              <b>{o.title}</b>
              <span className="muted small">{o.text}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">Your keys stay in this browser. govhub has no account server; Platform holds your identity.</p>
    </div>
  );
}

// ---- create ----------------------------------------------------------------------------------------------------------------

/** Three distinct word positions, from Web Crypto. */
function quizPositions(n: number): number[] {
  const out = new Set<number>();
  const r = new Uint32Array(1);
  while (out.size < 3) {
    crypto.getRandomValues(r);
    out.add(r[0]! % n);
  }
  return [...out].sort((a, b) => a - b);
}

function CreateFlow() {
  const [words, setWords] = useState<PhraseLength>(12);
  const [phrase, setPhrase] = useState(() => generatePhrase(12));
  const [step, setStep] = useState<'show' | 'quiz' | 'fund'>('show');
  const list = phrase.split(' ');

  if (step === 'show') {
    return (
      <div className="create">
        <p>
          This is your <b>recovery phrase</b>. It is the only way to get your identity back. Write the words down in order and keep them offline. Anyone who has them controls your identity.
        </p>
        <ol className="words" data-testid="phrase-words">
          {list.map((w, i) => (
            <li key={i}>
              <span className="muted">{i + 1}</span> {w}
            </li>
          ))}
        </ol>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => setStep('quiz')}>
            I wrote it down
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              const n: PhraseLength = words === 12 ? 24 : 12;
              setWords(n);
              setPhrase(generatePhrase(n));
            }}
          >
            Use {words === 12 ? 24 : 12} words instead
          </button>
        </div>
      </div>
    );
  }
  if (step === 'quiz') return <Quiz words={list} onBack={() => setStep('show')} onPass={() => setStep('fund')} />;
  return <FundNewIdentity phrase={phrase} identityIndex={0} />;
}

function Quiz({ words, onPass, onBack }: { words: string[]; onPass(): void; onBack(): void }) {
  const positions = useMemo(() => quizPositions(words.length), [words]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [wrong, setWrong] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ok = positions.every((p, i) => normalizePhrase(answers[i]!) === words[p]);
    setWrong(!ok);
    if (ok) onPass();
  };
  return (
    <form className="form quiz" onSubmit={submit}>
      <p>Check that you have it: type these words from your phrase.</p>
      <div className="row3">
        {positions.map((p, i) => (
          <label key={p}>
            Word #{p + 1}
            <input
              value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={`quiz-${p + 1}`}
            />
          </label>
        ))}
      </div>
      {wrong && <p className="error" role="alert">That doesn't match. Check your written copy, or go back and look again.</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">
          Continue
        </button>
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Show the phrase again
        </button>
      </div>
    </form>
  );
}

/** Funding choice for a new identity at `identityIndex` of `phrase`: pay with DASH (QR) or redeem a faucet voucher. */
function FundNewIdentity({ phrase, identityIndex, resume }: { phrase: string; identityIndex: number; resume?: boolean }) {
  const { network, signIn, closeSheet, platform } = useAuth();
  const [wallet, setWallet] = useState<SeedWallet | null>(null);
  const [how, setHow] = useState<'choose' | 'dash' | 'voucher'>(resume ? 'dash' : 'choose');
  const [error, setError] = useState<string | null>(null);
  const owned = useRef(false);
  // The wallet is made and wiped by the effect (StrictMode-safe): unless the session took it over, leaving this view wipes it.
  useEffect(() => {
    const w = SeedWallet.fromPhrase(phrase, network);
    setWallet(w);
    return () => {
      if (!owned.current) w.wipe();
    };
  }, [phrase, network]);

  const finish = async (identityId: string) => {
    if (!wallet) return;
    try {
      const s = await signInWithSeed(wallet, { identityIndex, identityId }, await platform());
      owned.current = true;
      signIn(s);
      closeSheet();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (!wallet) return null;
  if (how === 'choose') {
    return (
      <div className="fund-choice">
        <p>Your identity needs Platform credits to exist. Creating it costs about 0.0011 DASH; the rest stays as credit for posting.</p>
        <ul className="choices">
          <li>
            <button type="button" className="choice" onClick={() => setHow('dash')}>
              <b>Pay with DASH</b>
              <span className="muted small">Scan a QR code with any Dash wallet. 0.002 DASH minimum; 0.01 gives room for many posts.</span>
            </button>
          </li>
          <li>
            <button type="button" className="choice" onClick={() => setHow('voucher')}>
              <b>Redeem a voucher</b>
              <span className="muted small">Paste a starter voucher link from the faucet.</span>
            </button>
          </li>
        </ul>
      </div>
    );
  }
  return (
    <>
      {how === 'dash' ? <FundingPanel kind="create" wallet={wallet} identityIndex={identityIndex} onDone={finish} /> : <VoucherRedeem wallet={wallet} identityIndex={identityIndex} onDone={finish} />}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function VoucherRedeem({ wallet, identityIndex, onDone }: { wallet: SeedWallet; identityIndex: number; onDone(id: string): void }) {
  const { network, platform, dapi } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let voucher;
    try {
      voucher = parseVoucher(text, network);
    } catch (err) {
      return setError(errorText(err));
    }
    setBusy(true);
    try {
      const r = await redeemVoucher({ voucher, wallet, identityIndex, dapi: dapi(), platform: await platform(), onUpdate: (n) => setNote(n) });
      onDone(r.identityId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      wipe(voucher.privateKey);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Voucher link
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="dashpay://invite?assetlocktx=…&pk=…" spellCheck={false} autoComplete="off" disabled={busy} />
      </label>
      <p className="muted small">The voucher only pays for the identity. Its keys are the ones from your recovery phrase; the faucet never controls it.</p>
      {note && busy && (
        <p className="muted small" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> {note}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          {busy ? 'Redeeming…' : 'Redeem'}
        </button>
      </div>
    </form>
  );
}

// ---- existing phrase -------------------------------------------------------------------------------------------------------

function PhraseSignIn() {
  const { network, platform, signIn, closeSheet, store } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<{ phrase: string; found: FoundIdentity[]; resume?: FundingRecord } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidPhrase(text)) return setError(new PhraseError().message);
    const phrase = normalizePhrase(text);
    setBusy(true);
    const wallet = SeedWallet.fromPhrase(phrase, network);
    let handedOver = false;
    try {
      // An unfinished identity setup for this phrase continues first: its deposit may already be on the chain.
      const resume = pendingFundings(store, network).find(
        (r) => r.kind === 'create' && r.address === addressOf(wallet.derive(registrationFundingPath(network, r.identityIndex)).publicKey, network),
      );
      if (resume) return setState({ phrase, found: [], resume });
      const port = await platform();
      const found = await discoverIdentities(wallet, port);
      if (found.length === 1) {
        signIn(await signInWithSeed(wallet, found[0]!, port));
        handedOver = true;
        closeSheet();
        return;
      }
      setState({ phrase, found });
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (!handedOver) wallet.wipe();
      setBusy(false);
    }
  };
  const pick = async (f: FoundIdentity) => {
    if (!state) return;
    setBusy(true);
    const wallet = SeedWallet.fromPhrase(state.phrase, network);
    try {
      signIn(await signInWithSeed(wallet, f, await platform()));
      closeSheet();
    } catch (err) {
      wallet.wipe();
      setError(errorText(err));
      setBusy(false);
    }
  };

  if (state?.resume) return <FundNewIdentity phrase={state.phrase} identityIndex={state.resume.identityIndex} resume />;
  if (state && state.found.length === 0) {
    return (
      <div>
        <p>No identity on Platform ({network}) uses this phrase yet. You can create one now.</p>
        <FundNewIdentity phrase={state.phrase} identityIndex={0} />
      </div>
    );
  }
  if (state) {
    return (
      <div>
        <p>This phrase has {state.found.length} identities. Which one?</p>
        <ul className="choices">
          {state.found.map((f) => (
            <li key={f.identityId}>
              <button type="button" className="choice" disabled={busy} onClick={() => pick(f)}>
                <b className="break">{f.identityId}</b>
                <span className="muted small">identity #{f.identityIndex}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Recovery phrase (12 or 24 words)
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" autoCapitalize="none" data-testid="phrase-input" disabled={busy} />
      </label>
      <p className="muted small">The phrase never leaves this browser. govhub looks up your identity by a public key hash only.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          {busy ? <><span className="spinner" aria-hidden="true" /> Looking up…</> : 'Sign in'}
        </button>
      </div>
    </form>
  );
}

// ---- key paste -------------------------------------------------------------------------------------------------------------

function KeySignIn() {
  const { platform, signIn, closeSheet, openSheet } = useAuth();
  const [text, setText] = useState('');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      signIn(await signInWithKey(text, await platform()));
      setText('');
      if (keep) openSheet('passkeys');
      else closeSheet();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Private key (WIF or 64 hex characters)
        <input type="password" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} data-testid="key-input" disabled={busy} />
      </label>
      <p className="muted small">Use your identity's HIGH (or CRITICAL) authentication key, never the MASTER key. It stays in this tab's memory and is gone when you sign out or close the tab.</p>
      <label className="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep it with a passkey so I can sign in again without pasting
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </div>
    </form>
  );
}

// ---- top-up ----------------------------------------------------------------------------------------------------------------

function TopUp() {
  const { session, store, network, refreshBalance, closeSheet } = useAuth();
  const [done, setDone] = useState(false);
  // A passkey made on another device may have been planted by someone who once held one of this identity's keys. A key session from
  // such an entry derives its top-up address from that key, so the payer is warned first.
  const foreignPasskey = !!session?.credentialId && !localPasskeys.list(localStorage, session.identityId).includes(toBase64(session.credentialId));
  const [acknowledged, setAcknowledged] = useState(false);
  // Continue an unfinished top-up if there is one, else start the next index.
  const topUpIndex = useMemo(() => (session ? nextTopUpIndex(store, network, session.identityId) : 0), [session, store, network]);
  if (!session) return <p className="muted">Sign in first.</p>;
  if (foreignPasskey && !acknowledged) {
    return (
      <div className="notice-box" role="alert">
        <p>
          You signed in with a passkey that was not added in this browser. Only continue if you added it yourself: anyone who once held one of your keys could have
          added a passkey, and its key decides where this top-up is paid.
        </p>
        <button type="button" className="btn" onClick={() => setAcknowledged(true)}>
          I added this passkey, continue
        </button>
      </div>
    );
  }
  if (done) {
    return (
      <div>
        <p className="notice">Top-up complete. Your balance is updated.</p>
        <button type="button" className="btn btn-primary" onClick={closeSheet}>
          Close
        </button>
      </div>
    );
  }
  return (
    <div>
      <p>Add Platform credits with DASH from any wallet. 0.00051 DASH minimum; about 0.00008 DASH of it pays for the top-up itself.</p>
      <FundingPanel
        kind="topup"
        wallet={session.wallet}
        identityIndex={session.identityIndex ?? 0}
        topUp={{ identityId: session.identityId, index: topUpIndex }}
        session={session.wallet ? undefined : session}
        onDone={() => {
          refreshBalance();
          setDone(true);
        }}
      />
    </div>
  );
}
