// The proposal's discussion: every comment (paged by 100 from Platform), threaded here by parentId, with
// DashCentral-style indentation, scores, replies, retraction, ?comment= deep links, the comment view filter and
// block lists that hide (never delete) with a "show hidden (N)" toggle.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BLOCK_KIND,
  buildThreads,
  flatten,
  COMMENT_FMT,
  commentRetractRefund,
  COSTS,
  defaultFilter,
  hiddenFromOthers,
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
import { errText, formatAgoMs, formatCredits, formatInt } from '../lib/format.ts';
import { authorText, windowRoots, type Featured } from '../lib/social.ts';
import { Composer } from './Composer.tsx';
import { HiddenToggle } from './HiddenToggle.tsx';
import { AuthorName, Avatar } from './Identity.tsx';
import { Markdown } from './Markdown.tsx';
import { openSignIn } from './SignIn.tsx';
import { useReactions } from './useReactions.ts';
import { MnBadges } from '../badge/BadgeChip.tsx';
import { useBadges } from '../badge/context.tsx';
import { ReadError } from './ReadError.tsx';
import { TopUpError } from '../voting/funds.ts';
import { Votes } from './Votes.tsx';
import { WriteError } from './WriteError.tsx';

/** Replies deeper than this are not indented further (the thread line still shows). */
const MAX_INDENT = 6;
/** Comments rendered at first (whole threads, newest first) and per "show older"; only rendered comments have reactions read. */
const RENDER_PAGE = 200;
/** Comments whose reactions are read (one F6 query each) per page shown: one huge thread renders more, and the rest wait. */
const SCORED_PER_PAGE = 400;

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
  const latest = useRef<ThreadData | null>(null);
  latest.current = data;
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** Comments this reader posted, merged into the next read that finishes (also one still in flight): a post is never lost to a slow or lagging node. */
  const posted = useRef<Comment[]>([]);
  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const r = await forum.reader.comments(govHash);
      // the reader's own just-posted comments count too: a node that lags behind the post must not leave its author unnamed
      const pending = posted.current.filter((c) => c.govHash === govHash);
      const authors = [...new Set([...r.comments, ...pending].map((c) => c.ownerId))];
      const [profiles, names] = await Promise.all([authors.length ? forum.reader.profiles(authors) : new Map<string, Profile>(), forum.names(authors).catch(() => new Map<string, string>())]);
      if (live) {
        const mine = posted.current.filter((c) => c.govHash === govHash && !r.comments.some((x) => x.id === c.id));
        posted.current = [];
        setData({ comments: [...r.comments, ...mine], profiles, names, prov: forum.prov(r.height), truncated: r.truncated });
      }
    })().catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [forum, govHash, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** Local edits after a write, so a lagging node does not make the user's own comment vanish. */
  const add = useCallback(
    (c: Comment) => {
      posted.current = [...posted.current.filter((x) => x.id !== c.id), c];
      setData((d) => (d ? { ...d, comments: [...d.comments.filter((x) => x.id !== c.id), c] } : d));
      const d = latest.current;
      if (!d || d.profiles.has(c.ownerId) || d.names.has(c.ownerId)) return;
      // a first comment in this thread: its author's profile (perhaps made a moment ago) was never read for it
      void Promise.all([forum.reader.profiles([c.ownerId]), forum.names([c.ownerId]).catch(() => new Map<string, string>())]).then(
        ([profiles, names]) =>
          setData((d) => (d ? { ...d, profiles: new Map([...d.profiles, ...profiles]), names: new Map([...d.names, ...names]) } : d)),
        () => {},
      );
    },
    [forum],
  );
  const remove = useCallback((id: string) => {
    posted.current = posted.current.filter((x) => x.id !== id);
    setData((d) => (d ? { ...d, comments: d.comments.filter((x) => x.id !== id) } : d));
  }, []);
  return { data, error, reload, add, remove };
}

/**
 * The comments under one thread key: a proposal's govHash, or a username contest's key (contests/model.ts contestKey). `featured` are
 * the authors the default view always shows besides MN badge holders.
 */
export function Discussion({ govHash, featured }: { govHash: string; featured: Featured }) {
  const { source, registry, mode } = useApp();
  const { forum, session, write, moderation, reloadModeration } = useForum();
  const thread = useThread(govHash);
  const [params] = useSearchParams();
  const focus = params.get('comment');
  const [chosenFilter, setFilter] = useState<CommentFilter | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [revealed, setRevealed] = useState(new Set<string>());
  const [landed, setLanded] = useState<string | null>(null); // the comment just posted: scrolled to and highlighted, so nobody posts it twice
  const now = source.now();
  const comments = useMemo(() => thread.data?.comments ?? [], [thread.data]);
  // MN badges (PLAN §8.6) from the trusted issuers. Until any badge is live the default view is everyone (PLAN §12).
  const authors = useMemo(() => comments.map((c) => c.ownerId), [comments]);
  const badges = useBadges(authors);
  const badged = useCallback((id: string) => badges.byOwner.has(id), [badges.byOwner]);
  const BADGES_LIVE = badges.live;
  // A deep link shows everyone until the reader picks a view: badges load after the thread, so a later switch to the badge
  // filter would hide the linked comment.
  const filter = chosenFilter ?? (focus ? 'all' : defaultFilter(BADGES_LIVE));
  const roots = useMemo(() => buildThreads(comments), [comments]);
  const [limit, setLimit] = useState(RENDER_PAGE);
  const [extraScored, setExtraScored] = useState(0); // "read more scores" inside one thread too large for the window
  const isModerator = session?.identityId === registry.forum.moderationIdentityId;
  const viewer = session?.identityId ?? null; // what the viewer wrote always shows to them, whatever the filter
  const featuredIds = featured.ids;

  const reasonsOf = useCallback((c: Comment) => moderation.index.reasons(c), [moderation.index]);
  const hiddenCount = useMemo(() => comments.filter((c) => reasonsOf(c).length > 0).length, [comments, reasonsOf]);
  const filteredCount = useMemo(() => comments.filter((c) => !reasonsOf(c).length && !passesFilter(c, filter, { featured: featuredIds, badged, viewer })).length, [comments, reasonsOf, filter, featuredIds, badged, viewer]);
  const [unfiltered, setUnfiltered] = useState(false);
  // The deep-linked comment always gets at least its placeholder.
  const showOpts = useMemo(() => ({ reasonsOf, showHidden, revealed, filter, featured: featuredIds, badged, viewer }), [reasonsOf, showHidden, revealed, filter, featuredIds, badged, viewer]);
  const visible = useMemo(() => visibleSubtrees(roots, (c) => c.id === focus || shown(c, showOpts)), [roots, showOpts, focus]);
  // Fail closed: nothing renders before the block lists are read, and a list that failed collapses the thread until
  // the reader chooses to see it without that list.
  const gated = !moderation.ready || (!!moderation.error && !unfiltered);
  // Only the newest threads render (a flood cannot bury new comments or make the page read every reaction); older ones on request.
  const win = useMemo(() => windowRoots(roots, visible, limit, focus), [roots, visible, limit, focus]);
  // Scores are read for comments rendered in full (not placeholders: hidden parents, or a deep-linked comment a list hides).
  const scoring = useMemo(() => {
    if (gated) return { targets: [], unscored: 0 };
    const ids = flatten(win.roots).flatMap((n) => (shown(n.comment, showOpts) ? [n.comment.id] : []));
    const cap = SCORED_PER_PAGE * (limit / RENDER_PAGE) + extraScored;
    return { targets: ids.slice(-cap).map((commentId) => ({ commentId })), unscored: Math.max(0, ids.length - cap) };
  }, [gated, win, showOpts, limit, extraScored]);
  const targets = scoring.targets;
  const reactions = useReactions(targets);
  const focusMissing = !!focus && !!thread.data && !gated && !comments.some((c) => c.id === focus);

  // A deep link widens the view if the filter hides its comment and scrolls to it. A comment a block list hides stays
  // behind its placeholder: a shared link must not bypass the lists (one click on the placeholder reveals it).
  useEffect(() => {
    const c = focus ? comments.find((x) => x.id === focus) : undefined;
    if (!c) return;
    if (!passesFilter(c, filter, { featured: featuredIds, badged, viewer })) setFilter('all');
    requestAnimationFrame(() => document.getElementById(`comment-${focus}`)?.scrollIntoView({ block: 'center' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, comments.length]);

  useEffect(() => {
    if (!landed) return;
    const t = requestAnimationFrame(() => document.getElementById(`comment-${landed}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(t);
  }, [landed]);

  const post = useCallback(
    async (body: string, parentId?: string) => {
      if (!session) throw new Error('sign in first');
      const r = await write(forum.ops.comment(govHash, body, { fmt: COMMENT_FMT.markdown, ...(parentId ? { parentId } : {}) }));
      // Until Platform's copy (with block time) is read back, place the reply after its parent whatever the clocks say.
      const parentAt = comments.find((c) => c.id === parentId)?.createdAt ?? 0;
      const createdAt = Math.max(mode === 'live' ? Date.now() : now * 1000, parentAt + 1);
      thread.add({ id: r.id, ownerId: session.identityId, govHash, body, fmt: COMMENT_FMT.markdown, createdAt, ...(parentId ? { parentId } : {}) });
      setLanded(r.id);
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

  const reloadModerationTwice = useCallback(() => {
    reloadModeration();
    setTimeout(reloadModeration, 4000); // a node behind the write may not have the block yet
  }, [reloadModeration]);
  const block = useCallback(
    async (list: 'forum' | 'mod', target: string, kind: 1 | 2) => {
      await write(forum.ops.block(list, target, kind, list === 'mod' ? 'moderation' : undefined));
      reloadModerationTwice();
    },
    [write, forum, reloadModerationTwice],
  );
  const unblock = useCallback(
    async (list: 'forum' | 'mod', b: Block) => {
      await write(forum.ops.unblock(list, b.id));
      reloadModerationTwice();
    },
    [write, forum, reloadModerationTwice],
  );

  const ctx: NodeCtx = {
    now,
    featured,
    filter,
    badged,
    viewer,
    badges: badges.byOwner,
    showHidden,
    revealed,
    focus,
    landed,
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
  return (
    <section aria-labelledby="discussion-title" className="discussion" data-testid="discussion">
      <div className="discussion-head">
        <h2 id="discussion-title">
          Discussion {thread.data && <span className="count">{formatInt(count - hiddenCount)}{thread.data.truncated ? '+' : ''}</span>}
        </h2>
        <div className="discussion-tools">
          <fieldset className="seg" aria-label="Which comments to show">
            <legend className="visually-hidden">Comment view</legend>
            <label className={filter === 'recommended' ? 'on' : ''} title={`Authors with an MN badge from an issuer you trust (Settings), plus ${featured.who}`}>
              <input type="radio" name="comment-filter" checked={filter === 'recommended'} onChange={() => setFilter('recommended')} />
              {featured.view} and masternodes
            </label>
            <label className={filter === 'all' ? 'on' : ''}>
              <input type="radio" name="comment-filter" checked={filter === 'all'} onChange={() => setFilter('all')} />
              Everyone
            </label>
          </fieldset>
          <HiddenToggle count={hiddenCount} shown={showHidden} onToggle={() => setShowHidden((v) => !v)} show={`Show hidden (${hiddenCount})`} hide={`Hide blocked (${hiddenCount})`} />
        </div>
      </div>
      <p className="muted small filter-note">
        {filter === 'all'
          ? 'Showing everyone.'
          : `Showing ${featured.who}${BADGES_LIVE ? ' and masternode owners' : ' (no masternode badges are live yet)'}.`}{' '}
        {filter === 'recommended' && filteredCount > 0 && (
          <button type="button" className="linkish" onClick={() => setFilter('all')} data-testid="show-all">
            Show all {formatInt(filteredCount)} other {filteredCount === 1 ? 'comment' : 'comments'}
          </button>
        )}
        {listNote(moderation)}
      </p>

      {session ? (
        <Composer label="Post comment" onSubmit={(b) => post(b)} />
      ) : (
        <p className="signin-cta">
          <button type="button" className="btn" onClick={openSignIn}>
            Sign in to comment
          </button>{' '}
          <span className="muted small">Posting costs about {formatCredits(56_000_000, true)} from your account's balance.</span>
        </p>
      )}

      {thread.error && <ReadError error={thread.error} what="Platform" lead="Comments could not be read" onRetry={thread.reload} />}
      {!thread.data && !thread.error && (
        <p className="muted" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Loading comments…
        </p>
      )}
      {thread.data && count === 0 && <p className="muted">No comments yet.</p>}
      {thread.data?.truncated && (
        <p className="notice-warn small" data-testid="thread-truncated">
          This proposal has more comments than one read returns (10,000): the newest are shown, the oldest are not.
        </p>
      )}
      {focusMissing && (
        <p className="notice-warn small" role="status" data-testid="focus-missing">
          The linked comment isn't in this discussion: it may have been retracted, or this node doesn't have it yet.{' '}
          <Link to={{ search: '' }}>Show the whole discussion</Link>
        </p>
      )}
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
      {!gated && scoring.unscored > 0 && (
        <p className="center">
          <button type="button" className="btn btn-quiet" onClick={() => setExtraScored((n) => n + SCORED_PER_PAGE)} data-testid="read-more-scores">
            Read the scores of {formatInt(scoring.unscored)} older {scoring.unscored === 1 ? 'comment' : 'comments'} (their votes wait until then)
          </button>
        </p>
      )}
      {!gated && win.older > 0 && (
        <p className="center">
          <button type="button" className="btn btn-quiet" onClick={() => setLimit((l) => l + RENDER_PAGE)} data-testid="show-older">
            Show older comments ({formatInt(win.older)} more)
          </button>
        </p>
      )}
      {!gated && (
        <ol className="thread">
          {win.roots.map((n) => (
            <CommentNode key={n.comment.id} node={n} ctx={ctx} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** The filter note's last sentence: which lists hide spam, or that they are still being read or could not be read. */
function listNote(m: ReturnType<typeof useForum>['moderation']): string {
  if (m.subs.defaultOff) return ' The default block list is off (Settings).';
  if (!m.ready) return ' Reading the block lists…';
  const loaded = m.lists.map((l) => l.name).join(', ');
  if (loaded) return ` Spam is hidden by ${loaded}.`;
  return m.error ? ' The block lists could not be read.' : '';
}

interface NodeCtx {
  now: number;
  featured: Featured;
  filter: CommentFilter;
  badged(ownerId: string): boolean;
  /** the signed-in identity (its own comments always show) */
  viewer: string | null;
  /** ownerId -> names of the trusted issuers vouching for it */
  badges: Map<string, string[]>;
  showHidden: boolean;
  revealed: Set<string>;
  focus: string | null;
  /** id of the comment this reader just posted */
  landed: string | null;
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

function shown(c: Comment, ctx: Pick<NodeCtx, 'reasonsOf' | 'showHidden' | 'revealed' | 'filter' | 'badged' | 'viewer'> & { featured: readonly string[] }): boolean {
  const hidden = ctx.reasonsOf(c).length > 0 && !ctx.showHidden && !ctx.revealed.has(c.id);
  return !hidden && passesFilter(c, ctx.filter, { featured: ctx.featured, badged: ctx.badged, viewer: ctx.viewer });
}

function CommentNode({ node, ctx }: { node: ThreadNode; ctx: NodeCtx }) {
  const c = node.comment;
  const [replying, setReplying] = useState(false);
  const [confirmRetract, setConfirmRetract] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  // Hidden parents of visible replies leave a placeholder; subtrees with nothing shown are omitted.
  if (!ctx.visible.get(c.id)) return null;
  const reasons = ctx.reasonsOf(c);
  const isShown = shown(c, { ...ctx, featured: ctx.featured.ids });
  const isOwner = ctx.featured.ids.includes(c.ownerId);
  const mine = ctx.session === c.ownerId;
  // The reader's own comment always shows, but the recommended view ("Owner and masternodes") would hide it from everyone else: say so.
  const onlyYou = mine && hiddenFromOthers(c, ctx.filter, { featured: ctx.featured.ids, badged: ctx.badged });
  const score = ctx.scores.get(c.id);
  const myBlock = reasons.find((r) => r.source === 'mine');
  const modBlock = reasons.find((r) => r.source === 'default');
  const run = (label: string, f: () => Promise<void>) => async () => {
    setBusy(label);
    setError(null);
    setNeedsTopUp(false);
    try {
      await f();
      if (menu.current) menu.current.open = false; // the action is done: close the "Hide…" menu
    } catch (e) {
      setError(errText(e));
      setNeedsTopUp(e instanceof TopUpError);
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
    <li className={`comment ${ctx.focus === c.id ? 'comment-focus' : ''} ${ctx.landed === c.id ? 'comment-new' : ''} ${reasons.length ? 'comment-hidden' : ''} ${isOwner ? 'comment-owner' : ''}`} id={`comment-${c.id}`} data-comment-id={c.id}>
      <article aria-label={`Comment by ${authorText(c.ownerId, profile, ctx.names.get(c.ownerId))}`}>
        <header className="comment-head">
          <Avatar id={c.ownerId} profile={profile} />
          <AuthorName id={c.ownerId} profile={profile} dpns={ctx.names.get(c.ownerId)} />
          {isOwner && <span className="chip chip-owner">{ctx.featured.chip}</span>}
          <MnBadges issuers={ctx.badges.get(c.ownerId)} />
          <Link to={{ search: `?comment=${c.id}` }} className="comment-time" title={new Date(c.createdAt).toISOString()}>
            {formatAgoMs(c.createdAt, ctx.now)}
          </Link>
          {node.orphan && <span className="muted small">reply to a comment that is no longer available</span>}
        </header>
        {onlyYou && (
          <p className="hidden-note small" data-testid="only-you-note">
            Only you see this in the “{ctx.featured.view} and masternodes” view. Readers on “Everyone” see it too.
          </p>
        )}
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
        <WriteError error={error} needsTopUp={needsTopUp} />
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
