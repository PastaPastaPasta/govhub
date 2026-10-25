// Proposal ownership (PLAN §6.3): the verified owner from @govhub/verify's claim verifier, the claim flow
// (the exact string to sign in Dash Core, dash-cli, DMT or a hardware wallet, then paste the signature), and the
// owner's proposalPost shown in place of the raw fields, with its editor for the owner.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CLAIM_METHOD, COSTS, packPostBody, postCost, PostTooLargeError, POST_MAX_COMPRESSED, unpackPostBody, type Profile, type ProposalPost } from '@govhub/forum';
import { CLAIM_METHOD_LABEL, checkClaimSignature, claimMessage, decodeAddress, decodeSignature, hexToBytes, p2pkhAddress, verifyClaims, type ClaimVerdict } from '@govhub/verify';
import { claimWarning, rejectedChip } from '../lib/social.ts';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { attestorsFor } from '../config/registry.ts';
import type { Proposal } from '../data/types.ts';
import { errText, formatCredits, formatInt, shortAddress, shortHash } from '../lib/format.ts';
import type { TrustLevel } from '../verify/aggregate.ts';
import type { CollateralVerdict } from '../verify/collateral.ts';
import { HiddenToggle, plural } from './HiddenToggle.tsx';
import { AuthorName, Avatar } from './Identity.tsx';
import { Markdown } from './Markdown.tsx';
import { openSignIn } from './SignIn.tsx';
import { TopUpError, costText, isShort } from '../voting/funds.ts';
import { useAction } from './useAction.ts';
import { LowBalance, WriteError } from './WriteError.tsx';

export interface Ownership {
  verdict: ClaimVerdict | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

/** Reads the claims and attestations for a proposal and runs the verifier. Method 3 waits for the collateral check. */
export function useOwnership(p: Proposal, collateral: CollateralVerdict | null): Ownership {
  const { registry, source } = useApp();
  const { forum } = useForum();
  const [docs, setDocs] = useState<{ claims: Awaited<ReturnType<typeof forum.reader.claims>>; attestations: Awaited<ReturnType<typeof forum.reader.attestations>> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([forum.reader.claims(p.govHash), forum.reader.attestations(p.govHash)]).then(
      ([claims, attestations]) => live && setDocs({ claims, attestations }),
      (e: unknown) => live && (setError(errText(e)), setDocs({ claims: [], attestations: [] })),
    );
    return () => {
      live = false;
    };
  }, [forum, p.govHash, nonce]);
  const inputKeys = collateral?.inputKeys ?? null;
  const verdict = useMemo(
    () =>
      verifyClaims({
        network: source.coreNetwork,
        govHash: p.govHash,
        parentHash: p.parentHash,
        revision: p.revision,
        time: p.time,
        dataHex: p.dataHex,
        claims: docs?.claims ?? [],
        attestations: docs?.attestations ?? [],
        attestors: attestorsFor(registry),
        portals: registry.forum.claimPortals,
        collateralInputKeys: inputKeys,
      }),
    [registry, source.coreNetwork, p, docs, inputKeys],
  );
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { verdict, loading: docs === null, error, reload };
}

/** How the owner proved it, in a few words (CLAIM_METHOD_LABEL has the full name). */
const OWNER_HOW: Record<1 | 2 | 3 | 4, string> = {
  1: 'named in the proposal URL and accepted',
  2: 'signed with the payment address',
  3: 'signed with the collateral key',
  4: 'vouched for by the hosting team',
};

/** Profile and DPNS name of one identity, for the owner line. */
function useIdentityNames(id: string | null) {
  const { forum } = useForum();
  const [state, setState] = useState<{ id: string; profile: Profile | undefined; dpns: string | undefined } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    Promise.all([forum.reader.profiles([id]).catch(() => new Map<string, Profile>()), forum.names([id]).catch(() => new Map<string, string>())]).then(([p, n]) => {
      if (live) setState({ id, profile: p.get(id), dpns: n.get(id) });
    });
    return () => {
      live = false;
    };
  }, [forum, id]);
  return state?.id === id ? state : null;
}

/**
 * Who owns the proposal: the verified owner's name and how they proved it, or "Unclaimed proposal". An identity the proposal URL
 * names but that has not accepted is shown as named by the creator, never as the verified owner (naming is not consent).
 */
export function OwnerValue({ p, own }: { p: Proposal; own: Ownership }) {
  const { moderation } = useForum();
  const o = own.verdict?.owner ?? null;
  const n = own.verdict?.named;
  const named = n && !n.accepted && n.identityId !== o?.identityId ? n : null; // already the owner by signature: nothing to add
  const ownerNames = useIdentityNames(o?.identityId ?? null);
  const namedNames = useIdentityNames(named?.identityId ?? null);
  const who = (id: string, n: ReturnType<typeof useIdentityNames>, size = 20) => {
    const blocked = moderation.index.identityHidden(id);
    const profile = blocked ? undefined : n?.profile;
    return (
      <>
        <Avatar id={id} profile={profile} size={size} />
        <AuthorName id={id} profile={profile} dpns={blocked ? undefined : n?.dpns} />
        {blocked && <span className="muted small">(on a block list: name and avatar hidden)</span>}
      </>
    );
  };
  const namedNote = named && (
    <span className="owner-named muted small" data-testid="owner-named" data-named={named.identityId}>
      {who(named.identityId, namedNames, 16)}
      <span title={`The hashed proposal URL ${named.url} names this identity. It becomes the verified owner only once it accepts, by publishing its own claim.`}>
        Named by the proposal's creator, not verified until they accept
      </span>
    </span>
  );
  if (own.loading || !o) {
    return (
      <span className="owner-value owner-none" data-testid="owner-none">
        <span>{own.loading ? 'Checking who owns it…' : 'Unclaimed proposal'}</span>
        {namedNote}
        <span className="muted small">
          pays <span className="mono-ish break" title={p.paymentAddress}>{shortAddress(p.paymentAddress)}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="owner-value" data-testid="owner" data-owner={o.identityId} data-method={o.method}>
      {who(o.identityId, ownerNames)}
      <span className="muted small" title={`Claim checked in this browser: ${CLAIM_METHOD_LABEL[o.method]}`}>
        owner, {OWNER_HOW[o.method]}
      </span>
      {namedNote}
    </span>
  );
}

/**
 * The claims that do not decide ownership, hidden by default like blocked comments: valid ones outranked by the owner's (labelled
 * so, never as failures), ones that failed verification, and ones never checked (the spam budget), each with its reason.
 */
export function RejectedClaims({ own }: { own: Ownership }) {
  const [shown, setShown] = useState(false);
  const rejected = own.verdict?.rejected ?? [];
  const outranked = own.verdict?.valid.slice(1) ?? [];
  const total = rejected.length + outranked.length;
  if (total === 0) return null;
  const n = plural(total, 'other claim');
  return (
    <div className="rejected-claims small" data-testid="rejected-claims">
      <HiddenToggle count={total} shown={shown} onToggle={() => setShown((v) => !v)} show={`Show ${n}`} hide={`Hide ${n}`} testId="toggle-rejected-claims" />
      {shown && (
        <ul className="invalid-note">
          {outranked.map((c) => (
            <li key={c.docId ?? `${c.method}:${c.identityId}`} data-testid="claim-outranked">
              <span className="chip">Valid, outranked</span> <span className="mono-ish">{shortHash(c.identityId, 4)}</span> ({CLAIM_METHOD_LABEL[c.method]}): {c.detail}; the owner's claim ranks higher
              (claims rank by method, then by age).
            </li>
          ))}
          {rejected.map((r) => {
            const chip = rejectedChip(r.reason);
            return (
              <li key={r.docId} data-testid={chip.bad ? 'claim-failed' : 'claim-unchecked'}>
                <span className={`chip ${chip.bad ? 'chip-bad' : ''}`}>{chip.text}</span> <span className="mono-ish">{shortHash(r.ownerId, 4)}</span> (
                {CLAIM_METHOD_LABEL[r.method as keyof typeof CLAIM_METHOD_LABEL] ?? `method ${r.method}`}): {r.reason}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Claim flow for a signed-in identity that does not own the proposal yet. */
export function ClaimPanel({ p, own, collateral }: { p: Proposal; own: Ownership; collateral: CollateralVerdict | null }) {
  const { registry, source } = useApp();
  const { forum, session, write, balance } = useForum();
  const network = source.coreNetwork;
  const payP2pkh = decodeAddress(p.paymentAddress, network)?.type === 'p2pkh';
  const inputAddrs = useMemo(() => (collateral?.inputKeys ?? []).map((k) => p2pkhAddress(hexToBytes(k), network)), [collateral, network]);
  const [method, setMethod] = useState<2 | 3>(payP2pkh ? 2 : 3);
  const [inputAddr, setInputAddr] = useState('');
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; topUp?: boolean } | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null); // the warning the reader chose to publish through
  const o = own.verdict?.owner;
  const named = own.verdict?.named ?? null;
  if (o?.method === 1) return null; // the named identity accepted: nothing can outrank it
  const poor = isShort(balance, COSTS.claim);
  if (session && named && !named.accepted && named.identityId === session.identityId) return <AcceptNaming p={p} own={own} poor={poor} />;
  if (o && session && o.identityId === session.identityId) return null;

  const address = method === 2 ? p.paymentAddress : inputAddr || inputAddrs[0] || '';
  const message = session ? claimMessage(network, p.govHash, session.identityId) : '';
  const sigOk = !!session && !!address && sig.trim() !== '' && checkClaimSignature(address, sig.trim(), network, p.govHash, session.identityId);
  // Warn before paying for a claim that cannot win (D-036): the reader has to confirm it on purpose.
  const warning = session ? claimWarning(own.verdict, method, session.identityId) : null;
  const anyway = !!warning && ackFor === warning; // a different warning (another method) asks again
  const blocked = (!!warning && !anyway) || poor;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bytes = decodeSignature(sig.trim());
    if (!bytes || !sigOk || blocked) return;
    setBusy(true);
    setMsg(null);
    try {
      await write(forum.ops.claim(p.govHash, method === 2 ? CLAIM_METHOD.paymentAddress : CLAIM_METHOD.collateralInput, bytes));
      setMsg({ ok: true, text: 'Claim published. Checking it…' });
      setSig('');
      own.reload();
      setTimeout(own.reload, 4000);
    } catch (err) {
      setMsg({ ok: false, text: errText(err), topUp: err instanceof TopUpError });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="claim-panel" data-testid="claim-panel">
      <summary>{o ? 'Claim this proposal (a stronger claim outranks the current one)' : 'Are you the proposal owner? Claim it'}</summary>
      <div className="claim-body">
        <p className="small">
          A claim links the proposal to your identity: your comments get the owner label and you can publish the description shown here. The strongest proof wins: an identity
          named in the proposal URL that has accepted (proposals made with govhub's wizard, <span className="mono-ish">https://{registry.forum.claimPortals[0] ?? 'gov.dashhq.org'}/p/&lt;identity&gt;/&lt;name&gt;</span>),
          then a signature from the payment address, then from the key that paid the collateral, then an attestation by the hosting team (for P2SH or multisig payouts and lost keys:
          contact them).
        </p>
        {!session ? (
          <p>
            <button type="button" className="btn" onClick={openSignIn}>
              Sign in to claim
            </button>
          </p>
        ) : (
          <form className="form claim-form" onSubmit={submit}>
            <fieldset>
              <legend>1. Choose the key that signs</legend>
              <label className="check">
                <input type="radio" name="claim-method" checked={method === 2} disabled={!payP2pkh} onChange={() => setMethod(2)} /> Payment address{' '}
                <span className="mono-ish break">{p.paymentAddress}</span>
                {!payP2pkh && <span className="muted small"> (not a P2PKH address on {network}: it cannot sign messages)</span>}
              </label>
              <label className="check">
                <input type="radio" name="claim-method" checked={method === 3} disabled={inputAddrs.length === 0} onChange={() => setMethod(3)} /> A collateral input key{' '}
                {inputAddrs.length === 0 ? (
                  <span className="muted small">(available once the collateral check above has verified the transaction)</span>
                ) : (
                  <select value={address} onChange={(e) => setInputAddr(e.target.value)} disabled={method !== 3} aria-label="Collateral input address">
                    {inputAddrs.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                )}
              </label>
            </fieldset>
            <fieldset>
              <legend>2. Sign this exact message</legend>
              <pre className="code break" data-testid="claim-message">
                {message}
              </pre>
              <ul className="small sign-howto">
                <li>
                  Dash Core, Window → Console: <code className="break">signmessage "{address}" "{message}"</code>
                </li>
                <li>
                  dash-cli: <code className="break">dash-cli signmessage "{address}" "{message}"</code>
                </li>
                <li>Dash Masternode Tool or a hardware wallet: use its "Sign message" tool with the address above and paste the message exactly, without a trailing newline.</li>
              </ul>
            </fieldset>
            <fieldset>
              <legend>3. Paste the signature</legend>
              <label>
                Signature (base64, as Dash Core prints it)
                <textarea rows={2} className="code" value={sig} onChange={(e) => setSig(e.target.value)} spellCheck={false} />
              </label>
              {sig.trim() && (
                <p className={sigOk ? 'notice' : 'error'} data-testid="claim-sig-status">
                  {sigOk ? `Signature checks out for ${address}.` : `This signature does not verify for ${address} and this message.`}
                </p>
              )}
              <p className="muted small">
                Publishing the claim {costText(COSTS.claim)}; your balance is {balance === null ? '…' : formatCredits(balance)}.
              </p>
              {poor && balance !== null && <LowBalance what="the claim" balance={balance} fee={COSTS.claim} />}
              {warning && (
                <div className="notice-warn small" role="alert" data-testid="claim-warning">
                  <p>{warning}</p>
                  <label className="check">
                    <input type="checkbox" checked={anyway} onChange={(e) => setAckFor(e.target.checked ? warning : null)} data-testid="claim-anyway" /> I understand; publish it anyway
                  </label>
                </div>
              )}
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={!sigOk || busy || blocked}>
                  {busy ? 'Publishing…' : 'Publish claim'}
                </button>
              </div>
              {msg && (msg.ok ? <p className="notice">{msg.text}</p> : <WriteError error={msg.text} needsTopUp={msg.topUp} />)}
            </fieldset>
          </form>
        )}
      </div>
    </details>
  );
}

/** The identity the proposal URL names accepts ownership with a method-1 claim (no signature: its proven `$ownerId` is the consent). */
function AcceptNaming({ p, own, poor }: { p: Proposal; own: Ownership; poor: boolean }) {
  const { forum, write, balance } = useForum();
  const { busy, error, needsTopUp, run } = useAction();
  const [done, setDone] = useState(false);
  const accept = () =>
    run(async () => {
      await write(forum.ops.acceptNamedOwnership(p.govHash));
      setDone(true);
      own.reload();
      setTimeout(own.reload, 4000);
    });
  return (
    <section className="claim-panel" data-testid="accept-naming">
      <p>
        <b>The proposal URL names your identity.</b> Accept ownership to be shown as the verified owner: your comments get the owner label and you can publish the
        description shown here. Until you accept, govhub shows you only as named by the proposal's creator.
      </p>
      <p className="muted small">
        Accepting publishes a claim from your identity (no signature needed) and {costText(COSTS.claim)}; your balance is{' '}
        {balance === null ? '…' : formatCredits(balance)}.
      </p>
      {poor && balance !== null && <LowBalance what="the claim" balance={balance} fee={COSTS.claim} />}
      <p className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || poor || done} onClick={accept} data-testid="accept-naming-button">
          {busy ? 'Signing and broadcasting…' : done ? 'Accepted. Checking it…' : 'Accept ownership'}
        </button>
      </p>
      <WriteError error={error} needsTopUp={needsTopUp} />
    </section>
  );
}

/** The verified owner's post: title + markdown body. The editor is shown to the owner. */
export function useOwnerPost(govHash: string, ownerId: string | null) {
  const { forum } = useForum();
  const [state, setState] = useState<{ post: ProposalPost | null; body: string | null; error?: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!ownerId) return setState(null);
    let live = true;
    (async () => {
      const post = await forum.reader.post(govHash, ownerId);
      if (!post) return { post: null, body: null };
      try {
        return { post, body: await unpackPostBody(post.chunks) };
      } catch (e) {
        return { post, body: null, error: `the description could not be decoded: ${errText(e)}` };
      }
    })().then(
      (s) => live && setState(s),
      (e: unknown) => live && setState({ post: null, body: null, error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [forum, govHash, ownerId, nonce]);
  return { state, reload: () => setNonce((n) => n + 1), set: setState };
}

/**
 * Whether a page whose overall check came out as `level` may call the claimant "the verified proposal owner": not next to "Couldn't verify",
 * "Failed verification" or a check still running.
 */
export const ownerVerified = (level: TrustLevel): boolean => level === 'verified' || level === 'partial' || level === 'demo';

export function OwnerPost({ govHash, ownerId, post, trustLevel = 'verified' }: { govHash: string; ownerId: string; post: ReturnType<typeof useOwnerPost>; trustLevel?: TrustLevel }) {
  const { session, moderation } = useForum();
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const s = post.state;
  const isOwner = session?.identityId === ownerId;
  if (!s || !moderation.ready) return null;
  // Block lists apply here like anywhere else: an owner on a list, or this post's document, stays behind a click.
  const reasons = s.post && !isOwner ? moderation.index.reasons({ id: s.post.id, ownerId }) : [];
  if (reasons.length && !reveal) {
    return (
      <section className="owner-post" data-testid="owner-post">
        <p className="muted small">
          The owner's description is hidden: on {reasons.map((r) => r.list).join(', ')}.{' '}
          <button type="button" className="linkish" onClick={() => setReveal(true)}>
            Show it
          </button>
        </p>
      </section>
    );
  }
  // A description that does not decode failed verification: hidden behind the same kind of click, with the reason.
  if (s.error && !isOwner && !reveal) {
    return (
      <section className="owner-post" data-testid="owner-post">
        <p className="muted small" data-testid="owner-post-invalid">
          The owner's description failed verification: {s.error}.{' '}
          <button type="button" className="linkish" onClick={() => setReveal(true)}>
            Show it
          </button>
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="post-title" className="owner-post" data-testid="owner-post">
      {s.error && (
        <p className="invalid-note small">
          <span className="chip chip-bad">Failed verification</span> {s.post?.title ? `"${s.post.title}": ` : ''}
          {s.error}
        </p>
      )}
      {s.post && s.body !== null && !editing && (
        <>
          <h2 id="post-title">{s.post.title}</h2>
          <p className="muted small" data-testid="owner-post-byline">
            {ownerVerified(trustLevel)
              ? 'Written by the verified proposal owner; stored on Platform. govhub does not check what it says.'
              : "Written by the identity that claimed this proposal; stored on Platform. The proposal itself isn't fully verified here, and govhub does not check what the description says."}
          </p>
          <Markdown text={s.body} />
        </>
      )}
      {!s.post && !editing && <h2 id="post-title" className="visually-hidden">Owner's description</h2>}
      {isOwner && !editing && (
        <p>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {s.post ? 'Edit the description' : 'Write a description for this proposal'}
          </button>
        </p>
      )}
      {isOwner && editing && (
        <PostEditor
          govHash={govHash}
          existing={s.post}
          initialBody={s.body ?? ''}
          onDone={(saved) => {
            setEditing(false);
            if (saved) post.set(saved);
          }}
        />
      )}
    </section>
  );
}

function PostEditor({ govHash, existing, initialBody, onDone }: { govHash: string; existing: ProposalPost | null; initialBody: string; onDone(saved?: { post: ProposalPost; body: string }): void }) {
  const { forum, session, write, balance } = useForum();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(initialBody);
  const [packed, setPacked] = useState<{ chunks: Uint8Array[] } | { error: string; bytes?: number } | null>(null);
  const { busy, error, needsTopUp, run } = useAction();
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      if (!body.trim()) return setPacked(null);
      packPostBody(body).then(
        (chunks) => live && setPacked({ chunks }),
        (e: unknown) => live && setPacked(e instanceof PostTooLargeError ? { error: e.message, bytes: e.compressedBytes } : { error: errText(e) }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body]);
  const compressed = packed && 'chunks' in packed ? packed.chunks.reduce((n, c) => n + c.length, 0) : packed && 'bytes' in packed ? (packed.bytes ?? 0) : 0;
  const previous = existing ? existing.chunks.reduce((n, c) => n + c.length, 0) : undefined;
  const cost = postCost(compressed, previous);
  const poor = isShort(balance, cost);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!packed || !('chunks' in packed) || !session || poor) return;
    const { chunks } = packed;
    return run(async () => {
      const r = await write(forum.ops.proposalPost(govHash, title, chunks, existing ?? undefined));
      onDone({ post: { id: r.id, ownerId: session.identityId, revision: r.revision ?? 1, govHash, title: title.trim(), chunks }, body });
    });
  };
  return (
    <form className="form post-editor" onSubmit={save}>
      <h2 id="post-title">{existing ? 'Edit the description' : 'Describe your proposal'}</h2>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </label>
      <label>
        Description (markdown)
        <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className={`small ${packed && 'error' in packed ? 'error' : 'muted'}`} data-testid="post-meta">
        {packed && 'error' in packed
          ? packed.error
          : `${formatInt(new TextEncoder().encode(body).length)} bytes, ${formatInt(compressed)} of ${formatInt(POST_MAX_COMPRESSED)} bytes after compression (${packed && 'chunks' in packed ? packed.chunks.length : 0} of 3 fields) · ${costText(cost)} · your balance ${balance === null ? '…' : formatCredits(balance)}`}
      </p>
      {body.trim() && (
        <details>
          <summary>Preview</summary>
          <div className="composer-preview">
            <Markdown text={body} />
          </div>
        </details>
      )}
      {poor && balance !== null && <LowBalance what="this description" balance={balance} fee={cost} />}
      <WriteError error={error} needsTopUp={needsTopUp} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || poor || !title.trim() || !packed || !('chunks' in packed)}>
          {busy ? 'Signing and broadcasting…' : 'Publish description'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
