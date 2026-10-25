// Settings, "Recover funds": finds DASH stuck at govhub's one-time funding addresses from the chain alone (any device, nothing from
// this browser's storage needed) and sends it to a Dash address or puts it to use on Platform (@govhub/auth recovery.ts).
// The phrase or key is held in memory only while this section shows results, and wiped when it closes or the user is done with it.
import {
  BLOCKS_PER_DAY, estimateSweepFee, exportItemWif, findKeyIdentities, fundWithItem, identifierBytes, isValidPhrase, itemOptions, makeSession, normalizePhrase, parseDashAddress,
  parsePrivateKey, PhraseError, RECOVERY_START_HEIGHT, scanForFunds, SeedWallet, sweepItem, tipHeight, wipe,
  type FundingView, type RecoveryItem, type RecoveryScan, type RecoverySecret, type ScanProgress,
} from '@govhub/auth';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { SecretField } from './SecretField.tsx';
import { useAuth } from './context.tsx';
import { useLeaveWarning } from './leaveWarning.ts';
import { errorText, formatDuffs } from './runtime.ts';

type Start = 'default' | 'month' | 'year' | 'custom';
type Held = { secret: RecoverySecret; owned: boolean };

const short = (s: string) => `${s.slice(0, 10)}…`;

export function RecoverFunds() {
  const { session, network, platform, dapi } = useAuth();
  const [source, setSource] = useState<'session' | 'phrase' | 'key'>(session ? 'session' : 'phrase');
  const [phrase, setPhrase] = useState('');
  const [keyText, setKeyText] = useState('');
  const [start, setStart] = useState<Start>('default');
  const [custom, setCustom] = useState('');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<RecoveryScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = useRef<Held | null>(null);
  const ac = useRef<AbortController | null>(null);
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#recover') ref.current?.scrollIntoView();
  }, [hash]);
  useEffect(() => {
    if (!session && source === 'session') setSource('phrase');
  }, [session, source]);

  /** Wipes what this section derived the keys from (never the signed-in session's own secrets). */
  const forget = () => {
    const h = held.current;
    held.current = null;
    if (h?.owned) {
      h.secret.wallet?.wipe();
      h.secret.session?.end();
    }
  };
  useEffect(
    () => () => {
      ac.current?.abort();
      forget();
    },
    [],
  );

  const secretFor = async (): Promise<Held> => {
    if (source === 'session') {
      if (!session) throw new Error('Sign in first, or use a recovery phrase or key.');
      return { secret: session.wallet ? { wallet: session.wallet } : { session }, owned: false };
    }
    if (source === 'phrase') {
      if (!isValidPhrase(phrase)) throw new PhraseError();
      return { secret: { wallet: SeedWallet.fromPhrase(normalizePhrase(phrase), network) }, owned: true };
    }
    const priv = parsePrivateKey(keyText, network);
    try {
      const [m] = await findKeyIdentities(priv, await platform());
      return {
        secret: { session: makeSession({ network, identityId: m!.identityId, identityIndex: null, keyId: m!.keyId, securityLevel: m!.securityLevel, source: 'key', privateKey: priv, wallet: null }) },
        owned: true,
      };
    } catch (e) {
      wipe(priv);
      throw e;
    }
  };

  /** `again`: scan with the phrase or key already held (the input was cleared after the first scan). */
  const scan = async (again = false) => {
    setError(null);
    setResult(null);
    ac.current?.abort();
    if (!again) forget();
    const c = new AbortController();
    ac.current = c;
    setProgress({ phase: 'identities', done: 0, total: 0, keys: 0 });
    try {
      if (!held.current) held.current = await secretFor();
      setPhrase('');
      setKeyText('');
      const d = dapi();
      let fromHeight = RECOVERY_START_HEIGHT[network];
      if (start === 'custom') {
        fromHeight = Number(custom);
        if (!Number.isInteger(fromHeight) || fromHeight < 0) throw new Error('Enter a block height (a whole number).');
      } else if (start !== 'default') fromHeight = Math.max(0, (await tipHeight(d, c.signal)) - BLOCKS_PER_DAY * (start === 'month' ? 30 : 365));
      const r = await scanForFunds({ secret: held.current.secret, dapi: d, platform: await platform(), fromHeight, signal: c.signal, onProgress: (p) => !c.signal.aborted && setProgress({ ...p }) });
      if (!c.signal.aborted) setResult(r);
    } catch (err) {
      if (!c.signal.aborted) {
        setError(errorText(err));
        forget();
      }
    } finally {
      if (ac.current === c) setProgress(null);
    }
  };
  const cancel = () => {
    ac.current?.abort();
    setProgress(null);
    forget();
  };
  const done = () => {
    setResult(null);
    forget();
  };

  const other = network === 'mainnet' ? 'testnet' : 'mainnet';
  return (
    <section className="form recover" aria-labelledby="recover-title" id="recover" ref={ref}>
      <h2 id="recover-title">Recover funds</h2>
      <p className="small">
        Paid a deposit address and it didn't finish? Paid too little, too much, twice, or after the account was set up? This finds every payment and asset lock
        sitting at govhub's one-time addresses for your recovery phrase (or key), from the {network} chain itself: it works on any device, even if this browser forgot
        the setup. Then you can send it to any Dash address, or use it for your account.
      </p>
      <p className="muted small">
        Nothing leaves this browser but public key fingerprints (as a bloom filter) and the transactions you choose to send. govhub has no server that holds keys or
        funds, and support can't move them for you. This scans {network}; payments made on {other} show after switching the network profile.
      </p>
      {!result && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void scan();
          }}
        >
          <fieldset className="radios" disabled={!!progress}>
            <legend>Look for funds of</legend>
            {session && (
              <label className="check">
                <input type="radio" name="recover-source" checked={source === 'session'} onChange={() => setSource('session')} /> The account you are signed in to
                {session.wallet ? ' (its recovery phrase)' : ' (its key)'}
              </label>
            )}
            <label className="check">
              <input type="radio" name="recover-source" checked={source === 'phrase'} onChange={() => setSource('phrase')} /> A recovery phrase
            </label>
            <label className="check">
              <input type="radio" name="recover-source" checked={source === 'key'} onChange={() => setSource('key')} /> A private key I signed in with (top-ups paid
              while signed in with a key)
            </label>
          </fieldset>
          {source === 'phrase' && (
            <SecretField label="Recovery phrase (12 or 24 words)" what="the recovery phrase" value={phrase} onChange={setPhrase} testId="recover-phrase" disabled={!!progress} />
          )}
          {source === 'key' && (
            <label>
              Private key (WIF or 64 hex characters)
              <input type="password" value={keyText} onChange={(e) => setKeyText(e.target.value)} autoComplete="off" spellCheck={false} data-testid="recover-key" disabled={!!progress} />
            </label>
          )}
          <label>
            Look back to
            <select value={start} onChange={(e) => setStart(e.target.value as Start)} disabled={!!progress} data-testid="recover-start">
              <option value="default">When govhub started taking payments (block {RECOVERY_START_HEIGHT[network].toLocaleString('en-US')})</option>
              <option value="month">The last 30 days</option>
              <option value="year">The last year (slow)</option>
              <option value="custom">A block height I choose</option>
            </select>
          </label>
          {start === 'custom' && (
            <label>
              Start at block
              <input inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.trim())} placeholder={String(RECOVERY_START_HEIGHT[network])} />
            </label>
          )}
          <p className="muted small">
            Pick an older start if you first used govhub (or this phrase in another Dash Platform wallet) earlier. The scan replays every block since then from a
            DAPI node, roughly a minute per 5,000 to 10,000 blocks.
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            {progress ? (
              <button type="button" className="btn" onClick={cancel}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={(source === 'phrase' && !phrase.trim()) || (source === 'key' && !keyText.trim())} data-testid="recover-scan">
                Scan for funds
              </button>
            )}
          </div>
          {progress && <ScanStatus p={progress} />}
        </form>
      )}
      {result && held.current && (
        <Results
          scan={result}
          secret={held.current.secret}
          onRescan={() => void scan(true)}
          onDone={done}
        />
      )}
    </section>
  );
}

function ScanStatus({ p }: { p: ScanProgress }) {
  const text =
    p.phase === 'identities'
      ? 'Looking up your identities on Dash Platform…'
      : p.phase === 'scan'
        ? `Replaying blocks: ${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} (${p.keys} one-time addresses)`
        : 'Checking what was found with a second node and Dash Platform…';
  return (
    <div className="recover-progress" aria-live="polite" data-testid="recover-progress">
      <p className="muted small">
        <span className="spinner" aria-hidden="true" /> {text}
      </p>
      {p.phase === 'scan' && p.total > 0 && <progress max={p.total} value={p.done} />}
    </div>
  );
}

function Results({ scan, secret, onRescan, onDone }: { scan: RecoveryScan; secret: RecoverySecret; onRescan(): void; onDone(): void }) {
  const partial = scan.items.filter((i) => i.lock && i.lock.status !== 'unused');
  return (
    <div className="recover-results" data-testid="recover-results">
      {scan.items.length ? (
        <p className="notice" role="status" data-testid="recover-total">
          Found <b>{formatDuffs(scan.provenDuffs)}</b> you can recover{partial.length ? `, plus ${partial.length} asset lock${partial.length > 1 ? 's' : ''} Platform's state could not prove unused` : ''}.
        </p>
      ) : (
        <p className="notice" role="status" data-testid="recover-nothing">
          Nothing is stuck at these addresses.
        </p>
      )}
      <p className="muted small">
        Blocks {scan.fromHeight.toLocaleString('en-US')} to {scan.toHeight.toLocaleString('en-US')}, {scan.keysScanned} one-time addresses
        {scan.identities.length ? `, ${scan.identities.length} identit${scan.identities.length > 1 ? 'ies' : 'y'} of this phrase` : ''}.
        {scan.usedLocks ? ` ${scan.usedLocks} earlier payment${scan.usedLocks > 1 ? 's were' : ' was'} already used on Dash Platform (nothing to do).` : ''} Only payments
        proven in a block are shown; one from the last few minutes appears once it is mined.
        {scan.dropped ? ` ${scan.dropped} transaction${scan.dropped > 1 ? 's' : ''} a node sent without proof ${scan.dropped > 1 ? 'were' : 'was'} ignored.` : ''}
      </p>
      <ul className="recover-items">
        {scan.items.map((i) => (
          <li key={i.id}>
            <ItemCard item={i} scan={scan} secret={secret} />
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onRescan}>
          Scan again
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone} data-testid="recover-done">
          Done (forget the phrase or key)
        </button>
      </div>
    </div>
  );
}

const LOCK_STATUS: Record<string, string> = {
  unused: 'Dash Platform proves it has not been used.',
  partial: 'Dash Platform has used part of it; what is left can still be used.',
  unknown: "Dash Platform's state could not be read. Using it is safe: Platform refuses a used lock, and nothing is paid twice.",
};

function ItemCard({ item, scan, secret }: { item: RecoveryItem; scan: RecoveryScan; secret: RecoverySecret }) {
  const { dapi, platform, store, network } = useAuth();
  const opts = useMemo(() => itemOptions(item, scan), [item, scan]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<FundingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  useLeaveWarning(busy && !!view && view.state !== 'awaiting-deposit');

  const run = async (f: (signal: AbortSignal) => Promise<ReactNode>) => {
    setBusy(true);
    setError(null);
    setView(null);
    const c = new AbortController();
    ac.current = c;
    try {
      setOutcome(await f(c.signal));
    } catch (e) {
      if (!c.signal.aborted) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const sweep = (to: string) =>
    run(async (signal) => {
      const r = await sweepItem({ item, scan, secret, to, dapi: dapi(), store, signal });
      return (
        <>
          Sent {formatDuffs(r.sentDuffs)} to <span className="break">{to.trim()}</span> (fee {formatDuffs(r.feeDuffs)}). Transaction{' '}
          <span className="break mono-ish" data-testid="sweep-txid">
            {r.txid}
          </span>
        </>
      );
    });
  const fund = (target: { create: true } | { topUp: string }) =>
    run(async (signal) => {
      const r = await fundWithItem({ item, scan, secret, target, dapi: dapi(), platform: await platform(), store, signal, onUpdate: setView });
      return 'create' in target ? (
        <>
          Account created: <span className="break" data-testid="recovered-identity">{r.identityId}</span>. Sign in with your recovery phrase to use it.
        </>
      ) : (
        <>
          Added to identity <span className="break" data-testid="recovered-identity">{r.identityId}</span>.
        </>
      );
    });

  return (
    <article className="recover-item" data-testid="recover-item" data-type={item.type}>
      <header>
        <b>{formatDuffs(item.duffs)}</b> <span className="muted small">{item.type === 'lock' ? 'asset lock, on Dash Platform' : `${item.payments.length} payment${item.payments.length > 1 ? 's' : ''}, not yet used`}</span>
      </header>
      <p className="small">
        {item.label} #{item.index}: <span className="break mono-ish">{item.address}</span>
      </p>
      <ul className="small muted">
        {item.payments.map((p) => (
          <li key={`${p.txid}:${p.vout}`}>
            {formatDuffs(p.duffs)} in {short(p.txid)}:{p.vout}
            {p.height ? ` (block ${p.height})` : ''}
          </li>
        ))}
        {item.lock && (
          <li>
            Lock {short(item.lock.txid)}
            {item.lock.height ? ` (block ${item.lock.height})` : ''}. {LOCK_STATUS[item.lock.status]}
          </li>
        )}
      </ul>
      {outcome ? (
        <p className="notice" role="status" data-testid="recover-outcome">
          {outcome}
        </p>
      ) : (
        <>
          {opts.notes.length > 0 && <p className="muted small">{opts.notes.join(' ')}</p>}
          {(opts.create !== null || opts.topUp) && <UseOnPlatform opts={opts} scan={scan} busy={busy} onFund={fund} />}
          {opts.sweep && <SweepForm item={item} network={network} busy={busy} onSweep={sweep} />}
          {busy && view && (
            <p className="muted small" aria-live="polite">
              <span className="spinner" aria-hidden="true" /> {view.note ?? STATE_TEXT[view.state]}
            </p>
          )}
          {busy && view?.state === 'awaiting-deposit' && view.remainingDuffs > 0n && (
            <p className="small">
              This needs {formatDuffs(view.remainingDuffs)} more: send it to <span className="break mono-ish">{view.address}</span>, or stop and send these payments to an address
              instead.
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <ExportKey item={item} scan={scan} secret={secret} />
        </>
      )}
    </article>
  );
}

const STATE_TEXT: Record<FundingView['state'], string> = {
  'awaiting-deposit': 'Checking the payments…',
  locking: 'Making the asset lock…',
  locked: 'Asset lock sent; waiting for InstantSend…',
  registering: 'Registering on Dash Platform (a lock without its InstantSend lock waits for a ChainLock, a few minutes)…',
  done: 'Done',
};

function UseOnPlatform({ opts, scan, busy, onFund }: { opts: ReturnType<typeof itemOptions>; scan: RecoveryScan; busy: boolean; onFund(t: { create: true } | { topUp: string }): void }) {
  const [id, setId] = useState('');
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      identifierBytes(id.trim());
    } catch {
      return setBad(true);
    }
    onFund({ topUp: id.trim() });
  };
  return (
    <div className="form-actions recover-use">
      {opts.create !== null && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onFund({ create: true })} data-testid="recover-create">
          Create account #{opts.create} with it
        </button>
      )}
      {typeof opts.topUp === 'string' && opts.topUp !== 'any' && (
        <button type="button" className="btn" disabled={busy} onClick={() => onFund({ topUp: opts.topUp as string })} data-testid="recover-topup-own">
          Top up {short(opts.topUp)}
        </button>
      )}
      {opts.topUp === 'any' &&
        scan.identities.map((f) => (
          <button key={f.identityId} type="button" className="btn" disabled={busy} onClick={() => onFund({ topUp: f.identityId })} data-testid="recover-topup-mine">
            Top up identity #{f.identityIndex} ({short(f.identityId)})
          </button>
        ))}
      {opts.topUp === 'any' && (
        <form className="form recover-topup" onSubmit={submit}>
          <label>
            {scan.identities.length ? 'Or top up another identity' : 'Top up an identity'}
            <input value={id} onChange={(e) => (setId(e.target.value), setBad(false))} placeholder="identity id (base58)" spellCheck={false} autoComplete="off" data-testid="recover-topup-id" />
          </label>
          {bad && <p className="error small">That is not an identity id.</p>}
          <button type="submit" className="btn" disabled={busy || !id.trim()} data-testid="recover-topup-other">
            Top up this identity
          </button>
        </form>
      )}
    </div>
  );
}

function SweepForm({ item, network, busy, onSweep }: { item: RecoveryItem; network: 'mainnet' | 'testnet'; busy: boolean; onSweep(to: string): void }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const { problem, p2sh } = useMemo(() => {
    if (!to.trim()) return { problem: null, p2sh: false };
    try {
      return { problem: null, p2sh: parseDashAddress(to, network).type === 'p2sh' };
    } catch (e) {
      return { problem: errorText(e), p2sh: false };
    }
  }, [to, network]);
  // what buildSweep will charge for this destination
  const fee = estimateSweepFee(item.payments.length, p2sh);
  const sent = item.duffs - fee;
  if (!open) {
    return (
      <button type="button" className="btn" disabled={busy} onClick={() => setOpen(true)} data-testid="recover-sweep-open">
        Send to a Dash address
      </button>
    );
  }
  return (
    <form
      className="form recover-sweep"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && to.trim()) onSweep(to);
      }}
    >
      <label>
        Dash address ({network}) to send {item.payments.length > 1 ? 'these payments' : 'this payment'} to
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={network === 'mainnet' ? 'X…' : 'y…'} spellCheck={false} autoComplete="off" data-testid="recover-sweep-to" />
      </label>
      {problem && <p className="error small">{problem}</p>}
      <p className="small" data-testid="recover-sweep-amount">
        Sends <b>{formatDuffs(sent)}</b>; the network fee is {formatDuffs(fee)}. Check the address: a payment can't be undone.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !to.trim() || !!problem} data-testid="recover-sweep-send">
          {busy ? 'Sending…' : `Send ${formatDuffs(sent)}`}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Advanced: the one-time key as WIF, for another wallet. Behind a warning, masked until shown, dropped when hidden. Never logged. */
function ExportKey({ item, scan, secret }: { item: RecoveryItem; scan: RecoveryScan; secret: RecoverySecret }) {
  const [ack, setAck] = useState(false);
  const [wif, setWif] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="recover-export" onToggle={(e) => !(e.target as HTMLDetailsElement).open && (setWif(null), setShown(false), setAck(false))}>
      <summary className="small">Advanced: export this address's private key</summary>
      <p className="small">
        For importing into another wallet, e.g. Dash Core's <code>importprivkey</code> (legacy wallets) or a wallet with a "sweep private key" feature. Anyone who sees
        this key can take what is at {item.address}
        {item.type === 'lock' ? ' and use its asset lock' : ''}. Don't paste it into websites or chats; govhub support will never ask for it.
      </p>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand anyone with this key can take these funds
      </label>
      {wif === null ? (
        <button
          type="button"
          className="btn btn-quiet"
          disabled={!ack}
          onClick={() => {
            try {
              setWif(exportItemWif({ item, scan, secret }));
            } catch (e) {
              setError(errorText(e));
            }
          }}
          data-testid="recover-export"
        >
          Get the key
        </button>
      ) : (
        <div className="secret-field">
          <label>
            Private key (WIF)
            <input type={shown ? 'text' : 'password'} readOnly value={wif} autoComplete="off" spellCheck={false} data-testid="recover-wif" data-masked={!shown} />
          </label>
          <button type="button" className="btn btn-quiet" aria-pressed={shown} onClick={() => setShown((v) => !v)}>
            {shown ? 'Hide' : 'Show'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => void navigator.clipboard?.writeText(wif)}>
            Copy
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </details>
  );
}
