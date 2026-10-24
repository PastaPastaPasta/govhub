// Proposal ownership (PLAN §6.3): the verified owner from @govhub/verify's claim verifier, the claim flow
// (the exact string to sign in Dash Core, dash-cli, DMT or a hardware wallet, then paste the signature), and the
// owner's proposalPost shown in place of the raw fields, with its editor for the owner.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CLAIM_METHOD, COSTS, packPostBody, postCost, PostTooLargeError, POST_MAX_COMPRESSED, unpackPostBody, type ProposalPost } from '@govhub/forum';
import { CLAIM_METHOD_LABEL, checkClaimSignature, claimMessage, decodeAddress, decodeSignature, hexToBytes, p2pkhAddress, verifyClaims, type ClaimVerdict } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { attestorsFor } from '../config/registry.ts';
import type { Proposal, Provenance } from '../data/types.ts';
import { errText, formatCredits, formatInt } from '../lib/format.ts';
import type { CollateralVerdict } from '../verify/collateral.ts';
import { AuthorName, Avatar } from './Identity.tsx';
import { Markdown } from './Markdown.tsx';
import { openSignIn } from './SignIn.tsx';
import { useAction } from './useAction.ts';

export interface Ownership {
  verdict: ClaimVerdict | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

/** Reads the claims and attestations for a proposal and runs the verifier. Method 3 waits for the collateral check. */
export function useOwnership(p: Proposal, collateral: CollateralVerdict | null): Ownership {
  const { registry } = useApp();
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
        network: registry.coreNetwork,
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
    [registry, p, docs, inputKeys],
  );
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { verdict, loading: docs === null, error, reload };
}

export function ownerProvenance(o: ClaimVerdict['owner'], fixture: boolean): Provenance | null {
  if (!o) return null;
  if (fixture) return { kind: 'fixture', source: 'fixture discussion', detail: o.detail };
  if (o.method === 4) return { kind: 'proof', source: 'hosting team attestation', detail: `${o.detail}. Trusted: the team vouches for it; nothing here checks a key` };
  return { kind: 'verified', source: 'claim check in this browser', detail: o.detail };
}

/** The "Owner" value of the details table. */
export function OwnerValue({ p, own }: { p: Proposal; own: Ownership }) {
  const { forum, moderation } = useForum();
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof forum.reader.profiles>> | null>(null);
  const o = own.verdict?.owner ?? null;
  const blocked = !!o && moderation.index.identityHidden(o.identityId);
  useEffect(() => {
    if (!o) return;
    let live = true;
    forum.reader.profiles([o.identityId]).then((m) => live && setProfile(m), () => {});
    return () => {
      live = false;
    };
  }, [forum, o]);
  if (own.loading) return <>Checking claims… Pays to <span className="mono-ish break">{p.paymentAddress}</span></>;
  if (!o) {
    return (
      <>
        Not claimed yet. Pays to <span className="mono-ish break">{p.paymentAddress}</span>
      </>
    );
  }
  return (
    <span className="owner-value" data-testid="owner" data-owner={o.identityId} data-method={o.method}>
      <Avatar id={o.identityId} profile={blocked ? undefined : profile?.get(o.identityId)} size={20} />
      <AuthorName id={o.identityId} profile={blocked ? undefined : profile?.get(o.identityId)} />
      <span className="chip chip-owner">owner</span>
      {blocked && <span className="muted small">(on a block list: name and avatar hidden)</span>}
      <span className="muted small">by {CLAIM_METHOD_LABEL[o.method]}</span>
    </span>
  );
}

/** Claim flow for a signed-in identity that does not own the proposal yet. */
export function ClaimPanel({ p, own, collateral }: { p: Proposal; own: Ownership; collateral: CollateralVerdict | null }) {
  const { registry } = useApp();
  const { forum, session, write, balance } = useForum();
  const network = registry.coreNetwork;
  const payP2pkh = decodeAddress(p.paymentAddress, network)?.type === 'p2pkh';
  const inputAddrs = useMemo(() => (collateral?.inputKeys ?? []).map((k) => p2pkhAddress(hexToBytes(k), network)), [collateral, network]);
  const [method, setMethod] = useState<2 | 3>(payP2pkh ? 2 : 3);
  const [inputAddr, setInputAddr] = useState('');
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const o = own.verdict?.owner;
  if (o && session && o.identityId === session.identityId) return null;
  if (o?.method === 1) return null; // the hashed URL already names the owner; nothing can outrank it

  const address = method === 2 ? p.paymentAddress : inputAddr || inputAddrs[0] || '';
  const message = session ? claimMessage(network, p.govHash, session.identityId) : '';
  const sigOk = !!session && !!address && sig.trim() !== '' && checkClaimSignature(address, sig.trim(), network, p.govHash, session.identityId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bytes = decodeSignature(sig.trim());
    if (!bytes || !sigOk) return;
    setBusy(true);
    setMsg(null);
    try {
      await write(forum.ops.claim(p.govHash, method === 2 ? CLAIM_METHOD.paymentAddress : CLAIM_METHOD.collateralInput, bytes));
      setMsg({ ok: true, text: 'Claim published. Checking it…' });
      setSig('');
      own.reload();
      setTimeout(own.reload, 4000);
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
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
          embedded in the proposal URL (proposals made with govhub's wizard, <span className="mono-ish">https://{registry.forum.claimPortals[0] ?? 'gov.dashhq.org'}/p/&lt;identity&gt;/&lt;name&gt;</span>),
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
                Publishing the claim costs about {formatCredits(COSTS.claim, true)}; your balance is {balance === null ? '…' : formatCredits(balance)}.
              </p>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={!sigOk || busy}>
                  {busy ? 'Publishing…' : 'Publish claim'}
                </button>
              </div>
              {msg && <p className={msg.ok ? 'notice' : 'error'}>{msg.text}</p>}
            </fieldset>
          </form>
        )}
        {own.verdict && own.verdict.rejected.length > 0 && (
          <details className="small">
            <summary>
              {own.verdict.rejected.length} claim{own.verdict.rejected.length === 1 ? '' : 's'} that did not verify
            </summary>
            <ul>
              {own.verdict.rejected.map((r) => (
                <li key={r.docId}>
                  <span className="mono-ish">{r.ownerId.slice(0, 8)}…</span> (method {r.method}): {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
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

export function OwnerPost({ govHash, ownerId, post }: { govHash: string; ownerId: string; post: ReturnType<typeof useOwnerPost> }) {
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
  return (
    <section aria-labelledby="post-title" className="owner-post" data-testid="owner-post">
      {s.error && <p className="error small">{s.error}</p>}
      {s.post && s.body !== null && !editing && (
        <>
          <h2 id="post-title">{s.post.title}</h2>
          <p className="muted small">Written by the verified proposal owner; stored on Platform. govhub does not check what it says.</p>
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
  const { busy, error, run } = useAction();
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
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!packed || !('chunks' in packed) || !session) return;
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
          : `${formatInt(new TextEncoder().encode(body).length)} bytes, ${formatInt(compressed)} of ${formatInt(POST_MAX_COMPRESSED)} bytes after compression (${packed && 'chunks' in packed ? packed.chunks.length : 0} of 3 fields) · costs about ${formatCredits(cost, true)} · your balance ${balance === null ? '…' : formatCredits(balance)}`}
      </p>
      {body.trim() && (
        <details>
          <summary>Preview</summary>
          <div className="composer-preview">
            <Markdown text={body} />
          </div>
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !packed || !('chunks' in packed)}>
          {busy ? 'Signing and broadcasting…' : 'Publish description'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
