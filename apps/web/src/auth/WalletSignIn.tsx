// Sign in with a Dash wallet (App Connect, docs/app-connect.md). The page shows a `dashpay://connect` request as a QR code and a
// link; the wallet registers a key bound to govhub's forum contract (HIGH, with a budget and an expiry) and publishes it encrypted
// to this page; the page polls for that answer with proved reads, verifies every rule of the DIP, and asks "Continue as …?" before
// signing in, because anyone who sees a request can answer it. A separate chunk: loaded only when this view opens.
import {
  createEvoAppConnectPort,
  makeLoginRequest,
  newConnectionId,
  sessionFromGrant,
  startPolling,
  wipeGrant,
  type Grant,
  type LoginRequest,
  type AppConnectPort,
  type ConnectRequest,
  type Poller,
  type RejectReason,
} from '@govhub/auth/appconnect';
import { fromBase64, toBase64 } from '@govhub/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { FIXTURE_IDS } from '../data/fixtureForum.ts';
import { getSdk } from '../data/platform.ts';
import { fixtureSession } from '../session/fixture.ts';
import { formatCredits, formatDateTime, shortHash } from '../lib/format.ts';
import { useAuth } from './context.tsx';
import { Qr } from './Qr.tsx';
import { plainErrorText } from './runtime.ts';
import { demoWallet, type DemoWallet } from './walletDemo.ts';

const CONNECTION_KEY = 'govhub.appconnect.connection.';


/** One random CONNECTION_ID per browser and network, kept across sign-outs so the wallet can retire the previous grant's keys. */
function connectionId(network: string): Uint8Array {
  try {
    const have = localStorage.getItem(CONNECTION_KEY + network);
    if (have) {
      const b = fromBase64(have);
      if (b.length === 16) return b;
    }
    const id = newConnectionId();
    localStorage.setItem(CONNECTION_KEY + network, toBase64(id));
    return id;
  } catch {
    return newConnectionId();
  }
}

/** What a refused answer means, in words. */
const REJECTED: Partial<Record<RejectReason, string>> = {
  decrypt: 'it was not made for this code',
  framing: 'it was damaged',
  'key-not-found': 'its key is not on the identity',
  'key-disabled': 'its key is disabled',
  'key-expired': 'its key expires within the hour',
  'budget-exhausted': 'its key has no budget left',
  'key-limits': 'its key has no budget or no expiry',
  'key-unmatched': 'it holds a key govhub did not ask for',
  'key-level': 'its key has the wrong security level',
  'primary-missing': 'it holds no key for govhub',
};

type Phase = { kind: 'starting' } | { kind: 'waiting'; uri: string } | { kind: 'failed'; message: string };

export default function WalletSignIn() {
  const { registry, mode } = useApp();
  const { forum, signIn: forumSignIn } = useForum();
  const demo = mode === 'fixtures';
  const [sim, setSim] = useState<{ wallet: DemoWallet; request: ConnectRequest } | null>(null);
  const auth = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [grants, setGrants] = useState<Grant[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [note, setNote] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const poller = useRef<Poller | null>(null);
  const grantsRef = useRef<Grant[]>([]);
  // identities the user said "Not me" to: a fresh answer from them is not shown again for this code
  const declined = useRef(new Set<string>());
  grantsRef.current = grants;
  const network = registry.platformNetwork;
  const contractId = registry.forum.contractId;

  useEffect(() => {
    let live = true;
    let req: LoginRequest | null = null;
    setPhase({ kind: 'starting' });
    setGrants([]);
    setNote(null);
    setTrouble(null);
    declined.current = new Set();
    (async () => {
      // fixture mode: a simulated wallet and Platform (walletDemo.ts) answer instead
      const wallet = demo ? demoWallet() : null;
      const port: AppConnectPort = wallet ? wallet.port : createEvoAppConnectPort(await getSdk(registry));
      if (!live) return;
      req = makeLoginRequest({ contractId, network, connectionId: connectionId(network), now: Date.now() });
      setSim(wallet && { wallet, request: req.request });
      setPhase({ kind: 'waiting', uri: req.uri });
      poller.current = startPolling({
        request: req.request,
        appEphemeralPrivateKey: req.appEphemeralPrivateKey,
        port,
        onEvent(e) {
          if (!live || (e.type === 'grant' && declined.current.has(e.grant.identityId))) {
            if (e.type === 'grant') wipeGrant(e.grant);
            return;
          }
          if (e.type === 'grant') {
            setTrouble(null);
            // an identity that answers again (a second tap in the wallet) replaces its earlier answer
            setGrants((l) => {
              for (const x of l) if (x.identityId === e.grant.identityId) wipeGrant(x);
              return [...l.filter((x) => x.identityId !== e.grant.identityId), e.grant];
            });
          } else if (e.type === 'rejected') {
            setNote(`An answer from identity ${shortHash(e.ownerId, 5)} was refused: ${REJECTED[e.reason] ?? `it did not check out (${e.reason})`}. Still waiting.`);
          } else if (e.type === 'error') {
            setTrouble(plainErrorText(e.error, 'Dash Platform'));
          } else {
            setPhase({
              kind: 'failed',
              message: e.why === 'expired' ? 'This code expired after 10 minutes.' : 'This code got too many answers to check. Start again with a new one.',
            });
          }
        },
      });
    })().catch((e) => live && setPhase({ kind: 'failed', message: plainErrorText(e, 'Dash Platform') }));
    return () => {
      live = false;
      poller.current?.stop();
      poller.current = null;
      req?.end();
      grantsRef.current.forEach((g) => wipeGrant(g));
    };
  }, [attempt, registry, contractId, network, demo]);

  // back from the wallet app: look right away instead of at the next poll
  useEffect(() => {
    const poke = () => document.visibilityState === 'visible' && poller.current?.poke();
    addEventListener('focus', poke);
    document.addEventListener('visibilitychange', poke);
    return () => {
      removeEventListener('focus', poke);
      document.removeEventListener('visibilitychange', poke);
    };
  }, []);

  const ids = grants.map((g) => g.identityId).join(',');
  useEffect(() => {
    if (!ids) return;
    let live = true;
    forum.names(ids.split(',')).then((m) => live && setNames(m), () => {});
    return () => {
      live = false;
    };
  }, [ids, forum]);

  const accept = useCallback(
    (g: Grant) => {
      poller.current?.stop();
      grantsRef.current.filter((x) => x !== g).forEach((g) => wipeGrant(g));
      grantsRef.current = [];
      setGrants([]);
      if (demo && forum.store) {
        // fixture writes go to the in-memory store, never through a real key
        wipeGrant(g);
        forumSignIn(fixtureSession(forum.store, g.identityId, 'Dash wallet (demo)'));
      } else auth.signIn(sessionFromGrant(g, network));
      auth.closeSheet();
    },
    [auth, network, demo, forum.store, forumSignIn],
  );
  const decline = (g: Grant) => {
    declined.current.add(g.identityId);
    wipeGrant(g);
    setGrants((l) => l.filter((x) => x !== g));
  };

  if (phase.kind === 'starting') {
    return (
      <p className="muted" data-testid="wallet-starting">
        <span className="spinner" aria-hidden="true" /> Connecting to Dash Platform…
      </p>
    );
  }
  if (grants.length) {
    return (
      <div className="wallet-signin" data-testid="wallet-confirm">
        <p>{grants.length === 1 ? 'Your wallet answered.' : 'More than one identity answered this code. Choose yours.'}</p>
        <ul className="wallet-grants">
          {grants.map((g) => {
            const k = g.authKeys[0]!;
            const who = names.get(g.identityId);
            return (
              <li key={g.identityId} className="wallet-grant">
                <p className="wallet-who">
                  Continue as <b data-testid="wallet-name">{who ?? shortHash(g.identityId, 6)}</b>?
                </p>
                <p className="small muted break mono-ish">{g.identityId}</p>
                <p className="small">
                  govhub may spend up to <b>{k.remainingBudget === undefined ? 'its budget' : formatCredits(k.remainingBudget)}</b> of this identity’s credits on comments,
                  reactions and posts{k.key.expiresAt ? <>, until {formatDateTime(Math.floor(k.key.expiresAt / 1000))}</> : null}. It cannot move your money or change your keys.
                </p>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" onClick={() => accept(g)} data-testid="wallet-continue">
                    Continue
                  </button>
                  <button type="button" className="btn" onClick={() => decline(g)} data-testid="wallet-not-me">
                    Not me
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="small muted">Only continue if this is the identity you just approved in your wallet: anyone who sees a sign-in code can answer it.</p>
        <p className="small muted">The sign-in lasts while this tab is open. A reload or another tab asks your wallet again.</p>
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <div className="wallet-signin" data-testid="wallet-failed">
        <p className="error" role="alert">
          {phase.message}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="wallet-signin" data-testid="wallet-waiting">
      <div className="wallet-code">
        <Qr text={phase.uri} label="Sign-in request for your Dash wallet" />
        <div className="wallet-steps">
          <ol className="small">
            <li>Open DashPay on your phone and scan this code (or tap the button on this phone).</li>
            <li>Check the request: govhub asks for one key that can only post here, with a spending limit and an end date.</li>
            <li>Approve it. This page signs you in once Platform has your answer.</li>
          </ol>
          <a className="btn btn-primary" href={phase.uri} data-testid="wallet-open">
            Open in DashPay
          </a>
        </div>
      </div>
      <p className="muted small" aria-live="polite" data-testid="wallet-status">
        <span className="spinner" aria-hidden="true" /> Waiting for your wallet… The code works for 10 minutes.
      </p>
      {note && <p className="small notice-box" data-testid="wallet-note">{note}</p>}
      {sim && (
        <div className="notice-box small" data-testid="wallet-demo">
          <p>
            <b>Demo:</b> no wallet is needed. Answer this code as a sample person, the way DashPay would.
          </p>
          <div className="signin-picks">
            <button type="button" className="btn" onClick={() => (sim.wallet.approve(sim.request, FIXTURE_IDS.alice), poller.current?.poke())}>
              Approve as Alice
            </button>
            <button type="button" className="btn" onClick={() => (sim.wallet.answerBadly(sim.request, FIXTURE_IDS.bob), poller.current?.poke())}>
              Send a bad answer
            </button>
          </div>
        </div>
      )}
      {trouble && <p className="small error">{trouble} Still trying.</p>}
      <details className="learn">
        <summary>What does the wallet give govhub?</summary>
        <p className="small">
          A new key of your identity, made for govhub ({shortHash(contractId, 5)}): Dash Platform lets it write only to govhub’s forum contract, spend at most the
          budget you approve (0.1 DASH is suggested) and work only until the date you pick (90 days is suggested). It stays in this tab’s memory and is forgotten when
          you sign out. If your wallet says it needs an update, update DashPay and scan a new code.
        </p>
      </details>
      <button type="button" className="btn btn-quiet" onClick={() => setAttempt((n) => n + 1)}>
        New code
      </button>
    </div>
  );
}
