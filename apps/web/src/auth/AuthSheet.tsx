// Sign-in sheet (a modal <dialog>): a Dash wallet (App Connect) first, then a passkey; creating an identity, a recovery phrase and a
// pasted key sit under "Other ways to sign in". Plus the signed-in views reached from the account menu (top-up, passkeys). Secrets are held in component state only while a view needs
// them; the session takes ownership of the seed when sign-in completes, and closing the sheet drops the rest.
import {
  addressOf, discardFunding, discoverIdentities, generatePhrase, lockTooSmall, nextCreateIndex, isValidPhrase, localPasskeys, MIN_CREATE_DEPOSIT_DUFFS, MIN_TOPUP_DEPOSIT_DUFFS, nextTopUpIndex, normalizePhrase,
  createFundingPath, SUGGESTED_CREATE_DEPOSIT_DUFFS, parseVoucher, pendingFundings, PhraseError, redeemVoucher, SeedWallet, signInWithKey, signInWithSeed, toBase64, wipe, type FoundIdentity, type FundingRecord,
  type PhraseLength,
} from '@govhub/auth';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { FIXTURE_IDS } from '../data/fixtureForum.ts';
import { fixtureSession } from '../session/fixture.ts';
import { useAuth, type SheetView } from './context.tsx';
import { FundingPanel } from './FundingPanel.tsx';
import { PasskeySignIn, Passkeys } from './Passkeys.tsx';
import { RecoverLink } from './RecoverLink.tsx';
import { SecretField } from './SecretField.tsx';
import { formatDuffs, plainErrorText } from './runtime.ts';
import { IdentityName } from '../ui/Identity.tsx';

// App Connect is a separate chunk, loaded only when the wallet view opens (it is reachable only while the feature is on)
const WalletSignIn = lazy(() => import('./WalletSignIn.tsx'));

export { SecretField }; // moved to its own file (the Recover tool uses it too); tests import it from here

const TITLES: Record<SheetView, string> = {
  choose: 'Sign in to govhub',
  create: 'Create an account',
  phrase: 'Sign in with a recovery phrase',
  key: 'Sign in with a key',
  passkey: 'Sign in with a passkey',
  wallet: 'Sign in with a Dash wallet',
  topup: 'Top up',
  passkeys: 'Passkeys',
};

/** Views reached from the chooser while signed out: their header offers a way back to it. */
const FROM_CHOOSER: ReadonlySet<SheetView> = new Set(['create', 'phrase', 'key', 'passkey', 'wallet']);
const OTHER_WAYS: ReadonlySet<SheetView | null> = new Set(['create', 'phrase', 'key']);

export function AuthSheet() {
  const { sheet, closeSheet, openSheet, session } = useAuth();
  const ref = useRef<HTMLDialogElement>(null);
  // What had focus when the sheet opened: focus goes back there when it closes (or to the account button, if that control is gone).
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef<SheetView | null>(null);
  // Back from one of the other ways keeps that section open
  const backFrom = useRef<SheetView | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const prev = shown.current;
    shown.current = sheet;
    if (sheet && !d.open) {
      const a = document.activeElement;
      // <body> is no opener (Safari does not focus a clicked button): the account button is the fallback
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
      d.showModal();
      (d.querySelector<HTMLElement>('[data-autofocus]') ?? document.getElementById('sheet-title'))?.focus();
    } else if (sheet && prev && prev !== sheet) {
      // another view replaced the one holding focus: start from its title, which a screen reader reads out
      document.getElementById('sheet-title')?.focus();
    }
    if (!sheet && d.open) d.close();
  }, [sheet]);
  const onClose = () => {
    closeSheet();
    backFrom.current = null;
    const back = opener.current?.isConnected && opener.current.getClientRects().length ? opener.current : document.getElementById('session-button');
    opener.current = null;
    back?.focus();
  };
  const choose = sheet === 'choose';
  const canGoBack = !!sheet && !session && FROM_CHOOSER.has(sheet);
  return (
    <dialog ref={ref} className={`sheet${choose ? ' sheet-choose-dialog' : ''}`} aria-labelledby="sheet-title" onClose={onClose} onCancel={closeSheet}>
      {sheet && (
        <div className="sheet-body">
          <header className={`sheet-head${choose ? ' sheet-head-hero' : ''}`}>
            {canGoBack && (
              <button type="button" className="btn btn-quiet sheet-icon-btn" onClick={() => {
                  backFrom.current = sheet;
                  openSheet('choose');
                }}
                aria-label="Back to sign-in options" data-testid="sheet-back">
                <Icon name="back" />
              </button>
            )}
            <h2 id="sheet-title" tabIndex={-1}>
              {choose ? (
                <>
                  Sign in to <span className="brand-word">govhub</span>
                </>
              ) : (
                TITLES[sheet]
              )}
            </h2>
            <button type="button" className="btn btn-quiet sheet-icon-btn sheet-close" onClick={closeSheet} aria-label="Close">
              <Icon name="close" />
            </button>
          </header>
          {/* key = view: switching views unmounts the previous one and drops what it held */}
          {choose ? <Choose openMore={OTHER_WAYS.has(backFrom.current)} /> : <SheetContent key={sheet} view={sheet} />}
        </div>
      )}
    </dialog>
  );
}

const ICONS = {
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H17a1 1 0 0 1 1 1v1.5M4 7.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5M4 7.5A1.5 1.5 0 0 0 5.5 9H19a1 1 0 0 1 1 1v1.5M20 11.5h-3.5a1.5 1.5 0 0 0 0 3H20v-3Z',
  passkey: 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20v-.5a6 6 0 0 1 9-5.2M17.5 13.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5ZM17.5 18v3m0-1.5h1.5',
  plus: 'M12 5v14M5 12h14',
  words: 'M5 6h14M5 10h14M5 14h9M5 18h6',
  key: 'M14.5 9.5a4 4 0 1 1-1.2-2.8M14.5 9.5 20 15v3h-3v-2h-2v-2l-1.6-1.6M8.5 9.5h.01',
  chevron: 'm6 9 6 6 6-6',
  next: 'm9 6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  close: 'M6 6l12 12M18 6 6 18',
} as const;

function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SheetContent({ view }: { view: Exclude<SheetView, 'choose'> }) {
  switch (view) {
    case 'create':
      return <CreateFlow />;
    case 'phrase':
      return <PhraseSignIn />;
    case 'key':
      return <KeySignIn />;
    case 'passkey':
      return <PasskeySignIn />;
    case 'wallet':
      return (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <WalletSignIn />
        </Suspense>
      );
    case 'topup':
      return <WalletLimits what="topup" fallback={<TopUp />} />;
    case 'passkeys':
      return <WalletLimits what="passkeys" fallback={<Passkeys />} />;
  }
}

/**
 * A wallet sign-in holds a key the wallet granted for govhub's forum only, with its own budget and expiry: top-ups and passkeys
 * (which derive from or store the signing key) belong in the wallet. Other sessions see the normal view.
 */
function WalletLimits({ what, fallback }: { what: 'topup' | 'passkeys'; fallback: ReactNode }) {
  const { session } = useAuth();
  if (session?.source !== 'wallet') return fallback;
  return (
    <p className="notice-box" data-testid="wallet-limits">
      {what === 'topup'
        ? 'You signed in with your Dash wallet. Top up your identity from the wallet; govhub spends at most the budget you approved there.'
        : 'You signed in with your Dash wallet, which keeps your keys. A passkey here would store a temporary key; sign in from the wallet again instead.'}
    </p>
  );
}

/** Fixture mode: sample identities whose writes go into the in-memory fixture store (no keys, no network). */
function SampleIdentities() {
  const { registry } = useApp();
  const { forum, signIn } = useForum();
  const { closeSheet } = useAuth();
  const store = forum.store;
  if (!store) return null;
  const pick = (identityId: string, label: string) => {
    signIn(fixtureSession(store, identityId, label));
    closeSheet();
  };
  return (
    <div className="notice-box">
      <p>
        <b>Demo:</b> sign in as a sample person. What you post stays in this tab and costs pretend credit. A real account can sign in below, but can't post
        while demo data is shown.
      </p>
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
    </div>
  );
}

/**
 * Money this browser knows is waiting at a one-time address: a payment after the lock (any funding, finished ones too) or a lock too
 * small for what it was made for. The Recover tool sends it anywhere or uses it; it does not need this browser's records.
 */
function stuckDuffs(r: FundingRecord): bigint {
  const late = (r.lateDeposits ?? []).reduce((a, d) => a + BigInt(d.value), 0n);
  return late + (r.state === 'registering' && lockTooSmall(r) ? BigInt(r.lock!.lockDuffs) : 0n);
}

function RecoverableNotice({ records }: { records: FundingRecord[] }) {
  const { closeSheet } = useAuth();
  const stuck = records.map(stuckDuffs).filter((d) => d > 0n);
  if (!stuck.length) return null;
  return (
    <div className="notice-box" role="status" data-testid="recoverable">
      <p>
        <b>{formatDuffs(stuck.reduce((a, d) => a + d, 0n))}</b> is waiting at {stuck.length === 1 ? 'a deposit address' : 'deposit addresses'} from an earlier
        payment (paid after an account setup or top-up, or too small for it).
      </p>
      <RecoverLink onClick={closeSheet}>Recover funds</RecoverLink>
    </div>
  );
}

/**
 * The phrase or key is typed into a web page, so it should never guard real money: one made for govhub, holding only what govhub
 * needs. Shown inside the views where a phrase or key is entered, never on the chooser.
 */
function SeedWarning({ what = 'phrase' }: { what?: 'phrase' | 'key' }) {
  return (
    <p className="seed-warning" role="note" data-testid="seed-warning">
      <b>Use a {what === 'key' ? 'key from an account' : 'recovery phrase'} just for govhub.</b> You type it into a web page, so never use one that holds
      real money, or one you couldn’t afford to see leaked.
    </p>
  );
}

const DASH_WALLET_URL = 'https://www.dash.org/download/';
const BRIDGE_URL = 'https://bridge.dashhq.org/';

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function Choose({ openMore }: { openMore: boolean }) {
  const { openSheet, store, network, appConnect } = useAuth();
  const { mode } = useApp();
  const [, rerender] = useState(0);
  // With no wallet sign-in, the other ways are the only ones that work for most people: start with them open.
  const [more, setMore] = useState(!appConnect || openMore);
  const moreId = useId();
  const pending = pendingFundings(store, network).filter((r) => r.kind === 'create');
  const recoverable = store.list().filter((r) => r.network === network && !r.discarded);
  // A notice above the buttons is read first: the dialog then starts at its title, not past it
  const autofocus = !pending.length && !recoverable.some((r) => stuckDuffs(r) > 0n) && mode !== 'fixtures';
  const other: Array<{ v: SheetView; icon: keyof typeof ICONS; title: string; text: string }> = [
    { v: 'create', icon: 'plus', title: 'Create an account', text: `Pay a little DASH (${formatDuffs(SUGGESTED_CREATE_DEPOSIT_DUFFS)} suggested) from any Dash wallet.` },
    { v: 'phrase', icon: 'words', title: 'I have a recovery phrase', text: 'The 12 or 24 words of an account you made for govhub.' },
    { v: 'key', icon: 'key', title: 'Paste a key', text: 'For developers: a private key of your identity.' },
  ];
  return (
    <div className="sheet-choose">
      <p className="signin-lede">Reading is free and needs no account. Sign in to comment, react, or vote.</p>
      {mode === 'fixtures' && <SampleIdentities />}
      {pending.length > 0 && (
        <div className="notice-box" role="status">
          <p>
            <b>{pending.length === 1 ? 'An account setup is' : `${pending.length} account setups are`} in progress.</b> Enter its recovery phrase to continue.
          </p>
          <ul className="pending-list">
            {pending.map((r) => (
              <li key={r.key}>
                <span className="mono-ish">{r.address}</span>
                <span className="muted small">
                  {stuckDuffs(r) > 0n ? `${formatDuffs(stuckDuffs(r))} recoverable` : r.deposits.length || r.lock ? 'payment received' : 'no payment yet'}
                </span>
                {!r.deposits.length && !r.lock && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      // A payment made while no tab was watching is not visible here yet; the record is only hidden, never deleted.
                      if (!confirm(`Hide this setup? Only do this if you never sent DASH to ${r.address}. Continuing with the same phrase later still finds any payment.`)) return;
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
      <RecoverableNotice records={recoverable} />
      <div className="signin-main">
        <button type="button" className="btn btn-primary signin-btn" onClick={() => openSheet('wallet')} disabled={!appConnect} aria-describedby={appConnect ? undefined : 'wallet-soon'} data-testid="wallet-signin" data-autofocus={(appConnect && autofocus) || undefined}>
          <Icon name="wallet" />
          Sign in with Dash Wallet
          {!appConnect && (
            <span className="tag tag-info" id="wallet-soon">
              Coming soon
            </span>
          )}
        </button>
        <button type="button" className="btn signin-btn" onClick={() => openSheet('passkey')} data-testid="passkey-signin" data-autofocus={(!appConnect && autofocus) || undefined}>
          <Icon name="passkey" />
          Sign in with a passkey
        </button>
      </div>
      <div className="signin-more">
        <button type="button" className="signin-more-toggle" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((m) => !m)} data-testid="signin-more">
          Other ways to sign in
          <Icon name="chevron" size={16} />
        </button>
        <div id={moreId} className="signin-more-panel" hidden={!more}>
          <ul className="signin-alts">
            {other.map((o) => (
              <li key={o.v}>
                <button type="button" className="signin-alt" onClick={() => openSheet(o.v)}>
                  <span className="signin-alt-icon">
                    <Icon name={o.icon} size={18} />
                  </span>
                  <span className="signin-alt-text">
                    <b>{o.title}</b>
                    <span className="muted small">{o.text}</span>
                  </span>
                  <Icon name="next" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <details className="learn signin-learn">
            <summary>What is an account here?</summary>
            <p className="small">
              Your account is a Dash Platform identity. Comments and reactions are stored on Dash Platform and paid for with a little credit from your account’s
              balance (about 0.0005 DASH a comment). Your recovery phrase is the account: other Dash wallets (DashPay, Dash Evo Tool) can restore it. It stays in
              this browser; govhub has no account server and can’t reset it for you.
            </p>
          </details>
        </div>
      </div>
      <div className="signin-foot">
        <p>
          New to Dash? <OutLink href={DASH_WALLET_URL}>Get Dash Wallet</OutLink>
        </p>
        <p>
          Easy setup: <OutLink href={BRIDGE_URL}>bridge.dashhq.org</OutLink>
        </p>
      </div>
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

export function CreateFlow() {
  const [words, setWords] = useState<PhraseLength>(12);
  const [phrase, setPhrase] = useState(() => generatePhrase(12));
  const [step, setStep] = useState<'show' | 'quiz' | 'fund'>('show');
  const list = useMemo(() => phrase.split(' '), [phrase]);
  // Drawn once per phrase: a re-render (the app loading around the sheet) or going back to the phrase never moves them.
  const positions = useMemo(() => quizPositions(list.length), [list]);

  if (step === 'show') {
    return (
      <div className="create">
        <ol className="steps-bar" aria-label="Creating an account">
          <li aria-current="step">Save your phrase</li>
          <li>Check it</li>
          <li>Add credit</li>
        </ol>
        <p>
          These words are your <b>recovery phrase</b>. They <i>are</i> your account: write them down in order and keep them somewhere safe, offline. Anyone who
          has them can use your account, and nobody, govhub included, can recover it if you lose them.
        </p>
        <p className="seed-warning" role="note">
          <b>Keep this phrase for govhub only.</b> Don’t reuse it in a wallet, and don’t keep more DASH in it than govhub needs.
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
  if (step === 'quiz') return <Quiz words={list} positions={positions} onBack={() => setStep('show')} onPass={() => setStep('fund')} />;
  return <FundNewIdentity phrase={phrase} identityIndex={0} />;
}

function Quiz({ words, positions, onPass, onBack }: { words: string[]; positions: number[]; onPass(): void; onBack(): void }) {
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
      <ol className="steps-bar" aria-label="Creating an account">
        <li>Save your phrase</li>
        <li aria-current="step">Check it</li>
        <li>Add credit</li>
      </ol>
      <p>Type these words from your written copy, to be sure you have it.</p>
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

/**
 * Funding choice for a new identity at `identityIndex` of `phrase`: pay with DASH (QR), or redeem a voucher link someone gave you.
 * `resume`: an earlier visit began this setup, so go straight to the payment.
 */
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

  // `index`: a new account paid for after a too-small payment lives at a later index
  const finish = async (identityId: string, index = identityIndex) => {
    if (!wallet) return;
    try {
      const s = await signInWithSeed(wallet, { identityIndex: index, identityId }, await platform());
      owned.current = true;
      signIn(s);
      closeSheet();
    } catch (e) {
      setError(plainErrorText(e));
    }
  };
  if (!wallet) return null;
  if (how === 'choose') {
    return (
      <div className="fund-choice">
        <ol className="steps-bar" aria-label="Creating an account">
          <li>Save your phrase</li>
          <li>Check it</li>
          <li aria-current="step">Add credit</li>
        </ol>
        <p>
          Accounts live on Dash Platform, which needs a little credit to store them: about 0.0011 DASH for the account, and the rest stays in its balance for your
          comments.
        </p>
        <ul className="choices">
          <li>
            <button type="button" className="choice choice-l" onClick={() => setHow('dash')}>
              <b>Pay with DASH</b>
              <span className="muted small">Scan a QR code with any Dash wallet. {formatDuffs(SUGGESTED_CREATE_DEPOSIT_DUFFS)} lets you post right away; {formatDuffs(MIN_CREATE_DEPOSIT_DUFFS)} is the minimum.</span>
            </button>
          </li>
        </ul>
        <ul className="choices choices-s">
          <li>
            <button type="button" className="choice" onClick={() => setHow('voucher')}>
              <b>I have a voucher link</b>
              <span className="muted small">Paste a voucher link someone gave you.</span>
            </button>
          </li>
        </ul>
      </div>
    );
  }
  return (
    <>
      {how === 'dash' && <FundingPanel kind="create" wallet={wallet} identityIndex={identityIndex} onDone={finish} />}
      {how === 'voucher' && <VoucherRedeem wallet={wallet} identityIndex={identityIndex} onDone={finish} />}
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
      return setError(plainErrorText(err));
    }
    setBusy(true);
    try {
      const r = await redeemVoucher({ voucher, wallet, identityIndex, dapi: dapi(), platform: await platform(), onUpdate: (n) => setNote(n) });
      onDone(r.identityId);
    } catch (err) {
      setError(plainErrorText(err));
    } finally {
      wipe(voucher.privateKey);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <SecretField label="Voucher link" what="the voucher link" value={text} onChange={setText} placeholder="dashpay://invite?assetlocktx=…&pk=…" testId="voucher-input" disabled={busy} />
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
  const [state, setState] = useState<{ phrase: string; found: FoundIdentity[]; resume?: FundingRecord; createIndex?: number } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidPhrase(text)) return setError(new PhraseError().message);
    const phrase = normalizePhrase(text);
    setBusy(true);
    const wallet = SeedWallet.fromPhrase(phrase, network);
    let handedOver = false;
    try {
      // An unfinished identity setup of this phrase (hidden ones included: a payment made while no tab watched is only found by
      // replaying their address). One that already holds money continues first; an unpaid one only when the phrase has no identity.
      // A setup paid again after a too-small payment comes before the too-small one.
      const mine = store
        .list()
        .filter((r) => {
          if (r.network !== network || r.kind !== 'create' || r.state === 'done') return false;
          // the key a resume would fund from (the hardened pre-2026-10-25 one for a funding begun there)
          const d = wallet.derive(createFundingPath(store, wallet, r.identityIndex));
          try {
            return r.address === addressOf(d.publicKey, network);
          } finally {
            d.privateKey.fill(0); // only the address was needed
          }
        });
      const paid = (r: FundingRecord) => r.deposits.length > 0 || !!r.lock;
      const resume = mine.find((r) => paid(r) && !lockTooSmall(r)) ?? mine.find(paid) ?? mine[0];
      if (resume && (resume.deposits.length || resume.lock)) return setState({ phrase, found: [], resume });
      const port = await platform();
      const found = await discoverIdentities(wallet, port);
      if (!found.length && resume) return setState({ phrase, found: [], resume });
      if (found.length === 1) {
        signIn(await signInWithSeed(wallet, found[0]!, port));
        handedOver = true;
        closeSheet();
        return;
      }
      // a new identity skips an index whose payment was used to top up another identity
      setState({ phrase, found, createIndex: found.length ? undefined : nextCreateIndex(store, wallet) });
    } catch (err) {
      setError(plainErrorText(err));
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
      setError(plainErrorText(err));
      setBusy(false);
    }
  };

  if (state?.resume) return <FundNewIdentity phrase={state.phrase} identityIndex={state.resume.identityIndex} resume />;
  if (state && state.found.length === 0) {
    return (
      <div>
        <p>This phrase has no account on Dash Platform ({network}) yet. You can create one now.</p>
        <FundNewIdentity phrase={state.phrase} identityIndex={state.createIndex ?? 0} />
      </div>
    );
  }
  if (state) {
    return (
      <div>
        <p>This phrase has {state.found.length} accounts. Which one?</p>
        <ul className="choices">
          {state.found.map((f) => (
            <li key={f.identityId}>
              <button type="button" className="choice" disabled={busy} onClick={() => pick(f)}>
                <b>
                  <IdentityName id={f.identityId} />
                </b>
                <span className="muted small break">
                  identity #{f.identityIndex} · {f.identityId}
                </span>
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
      <SeedWarning />
      <SecretField label="Recovery phrase (12 or 24 words)" what="the recovery phrase" value={text} onChange={setText} testId="phrase-input" disabled={busy} />
      <p className="muted small">The phrase never leaves this browser. govhub finds your account by a public key fingerprint only.</p>
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
      setError(plainErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <SeedWarning what="key" />
      <label>
        Private key (WIF or 64 hex characters)
        <input type="password" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} data-testid="key-input" disabled={busy} />
      </label>
      <p className="muted small">Use your identity's HIGH (or CRITICAL) authentication key, never the MASTER key. It stays in memory (shared with your other open govhub tabs) and is gone when you sign out or close the browser.</p>
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
      <RecoverableNotice records={store.list().filter((r) => r.network === network && r.kind === 'topup' && r.identityId === session.identityId)} />
      <p>Add Platform credits with DASH from any wallet. {formatDuffs(MIN_TOPUP_DEPOSIT_DUFFS)} minimum; about 0.00008 DASH of it pays for the top-up itself.</p>
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
