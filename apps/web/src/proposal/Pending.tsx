// The list's view of proposals this browser paid for that govhub does not list yet: shown as pending, and the list reloads once one
// is live (the bridge publishes it a few minutes after it goes live, so a list loaded before then misses it).
import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { draftStage, draftStore, type ProposalDraft } from './draft.ts';

const RELOAD_EVERY_MS = 60_000;
/** A proposal goes live about 15 minutes after its fee and is listed a few minutes later; past this, stop waiting for it here. */
const PENDING_FOR_MS = 3 * 3600_000;

/** Real (not demo) drafts of this network, paid recently, whose proposal is not in `listed`. */
export function pendingDrafts(drafts: readonly ProposalDraft[], listed: ReadonlySet<string>, nowMs: number): ProposalDraft[] {
  return drafts.filter((d) => !d.demo && d.lock && d.payment?.txid && !listed.has(d.lock.govHash) && d.lock.lockedAt > nowMs - PENDING_FOR_MS && d.lock.endEpoch * 1000 > nowMs);
}

export function PendingProposals() {
  const { gov, source, mode, reload } = useApp();
  const active = gov.active.data;
  const pending = useMemo(() => {
    // nothing to compare with until the list has loaded; demo data never has the user's proposals
    if (!active || mode === 'fixtures') return [];
    let drafts: ProposalDraft[] = [];
    try {
      drafts = draftStore(localStorage).list(source.coreNetwork);
    } catch {
      /* storage blocked: nothing to show */
    }
    return pendingDrafts(drafts, new Set(active.map((p) => p.value.govHash)), Date.now());
  }, [active, mode, source]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // while one of ours is missing, load the list again every minute (it is otherwise loaded once)
  const waiting = pending.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => reloadRef.current(), RELOAD_EVERY_MS);
    return () => clearInterval(t);
  }, [waiting]);
  if (!waiting) return null;
  return (
    <ul className="pending-list" data-testid="pending-proposals">
      {pending.map((d) => (
        <li key={d.id} className="notice-box dh-notice dh-notice--info small">
          <b>{d.lock!.name}</b>{' '}
          {draftStage(d) === 'done' ? 'is live; it appears in this list in a moment.' : 'is on its way: it appears here once the network makes it live (about 15 minutes after payment).'}{' '}
          <Link to={`/create?d=${d.id}`}>Follow it</Link>
        </li>
      ))}
    </ul>
  );
}
