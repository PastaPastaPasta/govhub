// The proposal's discussion: every comment (paged by 100 from Platform), threaded here by parentId, with
// DashCentral-style indentation, scores, replies, retraction, ?comment= deep links, the comment view filter and
// block lists that hide (never delete) with a "show hidden (N)" toggle.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BLOCK_KIND,
  buildThreads,
  COMMENT_FMT,
  commentRetractRefund,
  COSTS,
  defaultFilter,
  passesFilter,
  type Block,
  type Comment,
  type CommentFilter,
  type HideReason,
  type Profile,
  type ThreadNode,
  visibleSubtrees,
} from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import type { Provenance } from '../data/types.ts';
import { formatAgoMs, formatCredits, formatInt } from '../lib/format.ts';
import { Composer } from './Composer.tsx';
import { AuthorName, Avatar } from './Identity.tsx';
import { Markdown } from './Markdown.tsx';
import { ProvMark } from './Provenance.tsx';
import { openSignIn } from './SignIn.tsx';
import { useReactions } from './useReactions.ts';
import { Votes } from './Votes.tsx';

/** MN badges arrive in phase 4 (PLAN §8); until the first epoch is live nobody is badged. */
const BADGES_LIVE = false;
const noBadge = (_ownerId: string) => false;
/** Replies deeper than this are not indented further (the thread line still shows). */
const MAX_INDENT = 6;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface ThreadData {
  comments: Comment[];
  profiles: Map<string, Profile>;
  names: Map<string, string>;
  prov: Provenance;
  truncated: boolean;
}

function useThread(govHash: string) {
  const { forum } = useForum();
  const [data, setData] = useState<ThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const r = await forum.reader.comments(govHash);
      const authors = [...new Set(r.comments.map((c) => c.ownerId))];
      const [profiles, names] = await Promise.all([authors.length ? forum.reader.profiles(authors) : new Map<string, Profile>(), forum.names(authors).catch(() => new Map<string, string>())]);
      if (live) setData({ comments: r.comments, profiles, names, prov: forum.prov(r.height), truncated: r.truncated });
    })().catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [forum, govHash, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** Local edits after a write, so a lagging node does not make the user's own comment vanish. */
  const add = useCallback((c: Comment) => setData((d) => (d ? { ...d, comments: [...d.comments.filter((x) => x.id !== c.id), c] } : d)), []);
  const remove = useCallback((id: string) => setData((d) => (d ? { ...d, comments: d.comments.filter((x) => x.id !== id) } : d)), []);
  return { data, error, reload, add, remove };
}

export function Discussion({ govHash, owner }: { govHash: string; owner: string | null }) {
  const { source, registry, mode } = useApp();
  const { forum, session, write, moderation, reloadModeration } = useForum();
  const thread = useThread(govHash);
  const [params] = useSearchParams();
  const focus = params.get('comment');
  const [filter, setFilter] = useState<CommentFilter>(defaultFilter(BADGES_LIVE));
  const [showHidden, setShowHidden] = useState(false);
  const [revealed, setRevealed] = useState(new Set<string>());
  const now = source.now();
  const comments = useMemo(() => thread.data?.comments ?? [], [thread.data]);
  const roots = useMemo(() => buildThreads(comments), [comments]);
  const targets = useMemo(() => comments.map((c) => ({ commentId: c.id })), [comments]);
  const reactions = useReactions(targets);
  const isModerator = session?.identityId === registry.forum.moderationIdentityId;

  const reasonsOf = useCallback((c: Comment) => moderation.index.reasons(c), [moderation.index]);
  const hiddenCount = useMemo(() => comments.filter((c) => reasonsOf(c).length > 0).length, [comments, reasonsOf]);
  const filteredCount = useMemo(() => comments.filter((c) => !reasonsOf(c).length && !passesFilter(c, filter, { owner, badged: noBadge })).length, [comments, reasonsOf, filter, owner]);
  const [unfiltered, setUnfiltered] = useState(false);
  // The deep-linked comment always gets at least its placeholder.
  const visible = useMemo(() => visibleSubtrees(roots, (c) => c.id === focus || shown(c, { reasonsOf, showHidden, revealed, filter, owner })), [roots, reasonsOf, showHidden, revealed, filter, owner, focus]);

  // A deep link widens the view if the filter hides its comment and scrolls to it. A comment a block list hides stays
  // behind its placeholder: a shared link must not bypass the lists (one click on the placeholder reveals it).
  useEffect(() => {
    if (!focus || !comments.some((c) => c.id === focus)) return;
    const c = comments.find((x) => x.id === focus)!;
    if (!passesFilter(c, filter, { owner, badged: noBadge })) setFilter('all');
    requestAnimationFrame(() => document.getElementById(`comment-${focus}`)?.scrollIntoView({ block: 'center' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, comments.length]);

  const post = useCallback(
    async (body: string, parentId?: string) => {
      if (!session) throw new Error('sign in first');
      const r = await write(forum.ops.comment(govHash, body, { fmt: COMMENT_FMT.markdown, ...(parentId ? { parentId } : {}) }));
      // Until Platform's copy (with block time) is read back, place the reply after its parent whatever the clocks say.
      const parentAt = comments.find((c) => c.id === parentId)?.createdAt ?? 0;
      const createdAt = Math.max(mode === 'live' ? Date.now() : now * 1000, parentAt + 1);
      thread.add({ id: r.id, ownerId: session.identityId, govHash, body, fmt: COMMENT_FMT.markdown, createdAt, ...(parentId ? { parentId } : {}) });
    },
    [session, write, forum, govHash, thread, now, comments, mode],
  );

  const retract = useCallback(
    async (c: Comment) => {
      await write(forum.ops.retractComment(c.id));
      thread.remove(c.id);
    },
    [write, forum, thread],
  );

  const block = useCallback(
    async (list: 'forum' | 'mod', target: string, kind: 1 | 2) => {
      await write(forum.ops.block(list, target, kind, list === 'mod' ? 'moderation' : undefined));
      reloadModeration();
      setTimeout(reloadModeration, 4000); // a node behind the write may not have the block yet
    },
    [write, forum, reloadModeration],
  );
  const unblock = useCallback(
    async (list: 'forum' | 'mod', b: Block) => {
      await write(forum.ops.unblock(list, b.id));
      reloadModeration();
      setTimeout(reloadModeration, 4000);
    },
    [write, forum, reloadModeration],
  );

  const ctx: NodeCtx = {
    now,
    owner,
    filter,
    showHidden,
    revealed,
    focus,
    profiles: thread.data?.profiles ?? new Map(),
    names: thread.data?.names ?? new Map(),
    reasonsOf,
    scores: reactions.scores,
    session: session?.identityId ?? null,
    isModerator,
    vote: (c, v) => reactions.vote({ commentId: c.id }, v),
    post,
    retract,
    block,
    unblock,
    reveal: (id) => setRevealed((s) => new Set(s).add(id)),
    visible,
  };

  const count = comments.length;
  // Fail closed: nothing renders before the block lists are read, and a list that failed collapses the thread until
  // the reader chooses to see it without that list.
  const gated = !moderation.ready || (!!moderation.error && !unfiltered);
  return (
    <section aria-labelledby="discussion-title" className="discussion" data-testid="discussion">
      <div className="discussion-head">
        <h2 id="discussion-title">
          Discussion {thread.data && <span className="count">{formatInt(count - hiddenCount)}</span>} {thread.data && <ProvMark prov={thread.data.prov} />}
        </h2>
        <div className="discussion-tools">
          <fieldset className="seg" aria-label="Which comments to show">
            <legend className="visually-hidden">Comment view</legend>
            <label className={filter === 'recommended' ? 'on' : ''} title="MN owners (badges arrive in phase 4) plus the proposal owner on their own proposal">
              <input type="radio" name="comment-filter" checked={filter === 'recommended'} onChange={() => setFilter('recommended')} />
              Proposal owner + MN owners
            </label>
            <label className={filter === 'all' ? 'on' : ''}>
              <input type="radio" name="comment-filter" checked={filter === 'all'} onChange={() => setFilter('all')} />
              Everyone
            </label>
          </fieldset>
          {hiddenCount > 0 && (
            <button type="button" className="btn btn-quiet" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)} data-testid="toggle-hidden">
              {showHidden ? `Hide blocked (${hiddenCount})` : `Show hidden (${hiddenCount})`}
            </button>
          )}
        </div>
      </div>
      <p className="muted small filter-note">
        {filter === 'all'
          ? BADGES_LIVE
            ? 'Showing everyone.'
            : 'Showing everyone. MN-owner badges arrive in phase 4; until then the recommended view would show only the proposal owner.'
          : `Showing the proposal owner${BADGES_LIVE ? ' and MN-badge holders' : ' (no MN badges are issued yet)'}.`}{' '}
        {filter === 'recommended' && filteredCount > 0 && (
          <button type="button" className="linkish" onClick={() => setFilter('all')} data-testid="show-all">
            Show all {formatInt(filteredCount)} other {filteredCount === 1 ? 'comment' : 'comments'}
          </button>
        )}
        {moderation.subs.defaultOff ? ' The default block list is off (Settings).' : ` Block lists: ${moderation.lists.map((l) => l.name).join(', ') || 'loading…'}.`}
      </p>

      {session ? (
        <Composer label="Post comment" onSubmit={(b) => post(b)} />
      ) : (
        <p className="signin-cta">
          <button type="button" className="btn" onClick={openSignIn}>
            Sign in to comment
          </button>{' '}
          <span className="muted small">Comments are Platform documents paid from your identity's credits (about {formatCredits(56_000_000, true)} for 280 characters).</span>
        </p>
      )}

      {thread.error && <p className="error">Comments could not be read: {thread.error}</p>}
      {!thread.data && !thread.error && (
        <p className="muted" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Loading comments…
        </p>
      )}
      {thread.data && count === 0 && <p className="muted">No comments yet.</p>}
      {thread.data?.truncated && <p className="error small">This proposal has more comments than one read returns (10,000); the oldest are shown.</p>}
      {reactions.error && <p className="error small">Scores could not be read: {reactions.error}</p>}
      {!moderation.ready && thread.data && count > 0 && (
        <p className="muted" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Applying block lists…
        </p>
      )}
      {moderation.ready && moderation.error && (
        <p className="notice-warn small" role="alert">
          {moderation.error}, so comments they would hide may show.{' '}
          {!unfiltered && (
            <button type="button" className="linkish" onClick={() => setUnfiltered(true)}>
              Show the comments anyway
            </button>
          )}
        </p>
      )}
      {!gated && (
        <ol className="thread">
          {roots.map((n) => (
            <CommentNode key={n.comment.id} node={n} ctx={ctx} />
          ))}
        </ol>
      )}
    </section>
  );
}

interface NodeCtx {
  now: number;
  owner: string | null;
  filter: CommentFilter;
  showHidden: boolean;
  revealed: Set<string>;
  focus: string | null;
  profiles: Map<string, Profile>;
  names: Map<string, string>;
  reasonsOf(c: Comment): HideReason[];
  scores: ReturnType<typeof useReactions>['scores'];
  session: string | null;
  isModerator: boolean;
  vote(c: Comment, v: 1 | -1): Promise<void>;
  post(body: string, parentId?: string): Promise<void>;
  retract(c: Comment): Promise<void>;
  block(list: 'forum' | 'mod', target: string, kind: 1 | 2): Promise<void>;
  unblock(list: 'forum' | 'mod', b: Block): Promise<void>;
  reveal(id: string): void;
  /** comment id -> it or a reply below it is shown (visibleSubtrees) */
  visible: Map<string, boolean>;
}

function shown(c: Comment, ctx: Pick<NodeCtx, 'reasonsOf' | 'showHidden' | 'revealed' | 'filter' | 'owner'>): boolean {
  const hidden = ctx.reasonsOf(c).length > 0 && !ctx.showHidden && !ctx.revealed.has(c.id);
  return !hidden && passesFilter(c, ctx.filter, { owner: ctx.owner, badged: noBadge });
}

function CommentNode({ node, ctx }: { node: ThreadNode; ctx: NodeCtx }) {
  const c = node.comment;
  const [replying, setReplying] = useState(false);
  const [confirmRetract, setConfirmRetract] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  // Hidden parents of visible replies leave a placeholder; subtrees with nothing shown are omitted.
  if (!ctx.visible.get(c.id)) return null;
  const reasons = ctx.reasonsOf(c);
  const isShown = shown(c, ctx);
  const isOwner = ctx.owner !== null && c.ownerId === ctx.owner;
  const mine = ctx.session === c.ownerId;
  const score = ctx.scores.get(c.id) ?? { up: 0, down: 0, net: 0 };
  const myBlock = reasons.find((r) => r.source === 'mine');
  const modBlock = reasons.find((r) => r.source === 'default');
  const run = (label: string, f: () => Promise<void>) => async () => {
    setBusy(label);
    setError(null);
    try {
      await f();
      if (menu.current) menu.current.open = false; // the action is done: close the "Hide…" menu
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const replies = node.children.length > 0 && (
    <ol className={`replies ${node.depth + 1 >= MAX_INDENT ? 'replies-flat' : ''}`}>
      {node.children.map((ch) => (
        <CommentNode key={ch.comment.id} node={ch} ctx={ctx} />
      ))}
    </ol>
  );

  if (!isShown) {
    const why = reasons.length ? `Hidden: on ${reasons.map((r) => r.list).join(', ')}` : 'Not in this view';
    return (
      <li className={`comment comment-placeholder ${ctx.focus === c.id ? 'comment-focus' : ''}`} id={`comment-${c.id}`} data-comment-id={c.id}>
        <p className="muted small">
          {why}.{' '}
          {reasons.length > 0 && (
            <button type="button" className="linkish" onClick={() => ctx.reveal(c.id)}>
              Show this comment
            </button>
          )}
        </p>
        {replies}
      </li>
    );
  }

  const profile = ctx.profiles.get(c.ownerId);
  return (
    <li className={`comment ${ctx.focus === c.id ? 'comment-focus' : ''} ${reasons.length ? 'comment-hidden' : ''} ${isOwner ? 'comment-owner' : ''}`} id={`comment-${c.id}`} data-comment-id={c.id}>
      <article aria-label={`Comment by ${profile?.displayName ?? c.ownerId}`}>
        <header className="comment-head">
          <Avatar id={c.ownerId} profile={profile} />
          <AuthorName id={c.ownerId} profile={profile} dpns={ctx.names.get(c.ownerId)} />
          {isOwner && <span className="chip chip-owner">proposal owner</span>}
          <Link to={{ search: `?comment=${c.id}` }} className="comment-time" title={new Date(c.createdAt).toISOString()}>
            {formatAgoMs(c.createdAt, ctx.now)}
          </Link>
          {node.orphan && <span className="muted small">reply to a comment that is no longer available</span>}
        </header>
        {reasons.length > 0 && (
          <p className="hidden-note small">
            Hidden for you: {reasons.map((r) => `${r.kind === 'identity' ? 'author' : 'comment'} on ${r.list}${r.reason ? ` (${r.reason})` : ''}`).join('; ')}
          </p>
        )}
        <div className="comment-body">
          <Markdown text={c.body} markdown={c.fmt === COMMENT_FMT.markdown} />
        </div>
        <footer className="comment-actions">
          <Votes score={score} signedIn={!!ctx.session} label="Comment score" onVote={(v) => (ctx.session ? ctx.vote(c, v) : (openSignIn(), Promise.resolve()))} />
          {ctx.session && (
            <button type="button" className="btn btn-quiet btn-s" onClick={() => setReplying((r) => !r)} aria-expanded={replying}>
              Reply
            </button>
          )}
          {mine &&
            (confirmRetract ? (
              <>
                <button type="button" className="btn btn-s btn-danger" disabled={!!busy} onClick={run('retract', () => ctx.retract(c))}>
                  {busy === 'retract' ? 'Retracting…' : `Confirm: delete (refunds about ${formatCredits(-commentRetractRefund(new TextEncoder().encode(c.body).length), true)})`}
                </button>
                <button type="button" className="btn btn-quiet btn-s" onClick={() => setConfirmRetract(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-quiet btn-s" onClick={() => setConfirmRetract(true)}>
                Retract
              </button>
            ))}
          {ctx.session && !mine && (
            <details className="menu" ref={menu}>
              <summary className="btn btn-quiet btn-s">Hide…</summary>
              <div className="menu-body">
                {myBlock ? (
                  <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('unblock', () => ctx.unblock('forum', myBlock.block))}>
                    Unblock ({myBlock.kind === 'identity' ? 'author' : 'comment'}, refunds about {formatCredits(-COSTS.blockDelete, true)})
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('block', () => ctx.block('forum', c.id, BLOCK_KIND.document))}>
                      Hide this comment for me
                    </button>
                    <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('block', () => ctx.block('forum', c.ownerId, BLOCK_KIND.identity))}>
                      Hide everything by this author
                    </button>
                    <p className="muted small">Adds a block to your own list (about {formatCredits(COSTS.blockCreate, true)}). Others can subscribe to it.</p>
                  </>
                )}
                {ctx.isModerator &&
                  (modBlock ? (
                    <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('unblock', () => ctx.unblock('mod', modBlock.block))}>
                      Remove from the default list
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('block', () => ctx.block('mod', c.id, BLOCK_KIND.document))}>
                        Add comment to the default list
                      </button>
                      <button type="button" className="btn btn-s" disabled={!!busy} onClick={run('block', () => ctx.block('mod', c.ownerId, BLOCK_KIND.identity))}>
                        Add author to the default list
                      </button>
                    </>
                  ))}
                {busy && <p className="muted small">Signing…</p>}
              </div>
            </details>
          )}
        </footer>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {replying && (
          <Composer
            label="Post reply"
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={async (b) => {
              await ctx.post(b, c.id);
              setReplying(false);
            }}
          />
        )}
      </article>
      {replies}
    </li>
  );
}
