// After the fee is paid: confirmations (proven where the chain can be verified), submission through relays with fallback, and then
// whether the network and govhub have the proposal. One `submissionTick` per poll; it returns the updated draft and never throws for
// a relay or network failure (those are recorded on the draft and retried on the next tick).
import { GOVERNANCE_FEE_CONFIRMATIONS } from '@govhub/verify';
import type { DraftSubmission, ProposalDraft, RelayReceipt } from './draft.ts';
import { isTransient, relayErrorText, type ProposalRelayPort } from './relay.ts';
import { submitBody, type CollateralCheck, type WizardServices } from './services.ts';

export interface TickResult {
  draft: ProposalDraft;
  check: CollateralCheck | null;
  /** The collateral does not pay this proposal's fee: nothing can be submitted with it. */
  invalid?: string;
}

/** Failed status reads in a row before a holding relay is treated as down and the next one is tried. */
const MAX_STATUS_FAILURES = 3;
const statusFailures = new Map<string, number>();

/** A relay outcome that the next relay would not change: the proposal or the collateral itself is refused. */
const definite = (code: string | null | undefined) => code === 'core-rejected' || code === 'bad-proposal' || code === 'bad-collateral' || code === 'expired';

const cloneSubmission = (d: ProposalDraft): DraftSubmission => structuredClone(d.submission ?? { relays: [] });

export async function submissionTick(d: ProposalDraft, s: WizardServices, now = Date.now()): Promise<TickResult> {
  const lock = d.lock;
  const txid = d.payment?.txid;
  if (!lock || !txid) return { draft: d, check: null };
  const sub = cloneSubmission(d);
  let check: CollateralCheck | null = null;
  try {
    check = await s.checkCollateral(lock, txid);
  } catch {
    check = null;
  }
  if (check?.state === 'invalid') return { draft: { ...d, submission: sub }, check, invalid: check.message ?? 'this transaction does not pay this proposal\'s fee' };
  if (check && (check.state === 'mined' || check.state === 'mempool')) sub.confirmations = { n: check.confirmations, basis: check.basis, final: check.final, at: now };

  if (!sub.submittedAt) await submitThroughRelays(d, sub, s, check, now);

  if (!sub.seenAt) {
    const seen = await s.seenByNetwork(lock.govHash).catch(() => null);
    if (seen) {
      sub.seenAt = now;
      // submitted by someone (Dash Core by hand, another relay): the network has it either way
      sub.submittedAt ??= now;
      sub.via ??= 'network';
    }
  }
  if (sub.submittedAt && !sub.publishedAt && (await s.onGovhub(lock.govHash).catch(() => false))) {
    sub.publishedAt = now;
    sub.seenAt ??= now;
  }
  return { draft: { ...d, submission: sub }, check };
}

async function submitThroughRelays(d: ProposalDraft, sub: DraftSubmission, s: WizardServices, check: CollateralCheck | null, now: number): Promise<void> {
  const lock = d.lock!;
  const body = submitBody(lock, d.payment!.txid!, d.network);
  const relays = s.relays();
  const receipt = (r: ProposalRelayPort) => sub.relays.find((x) => x.base === r.base);
  const put = (r: ProposalRelayPort, patch: Partial<RelayReceipt>) => {
    const old = receipt(r);
    const next: RelayReceipt = { name: r.name, base: r.base, id: null, status: 'waiting', ...old, ...patch, updatedAt: now };
    sub.relays = [...sub.relays.filter((x) => x.base !== r.base), next];
    return next;
  };
  const enoughConfs = !!check && check.state === 'mined' && check.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS;

  for (const r of relays) {
    const have = receipt(r);
    if (have && (have.status === 'failed' || have.status === 'unreachable')) continue; // this relay gave up: the next one
    try {
      if (!have || (!have.id && !have.legacy)) {
        const h = await r.hold(body, lock.govHash);
        if (h.kind === 'legacy') put(r, { id: null, legacy: true, status: 'waiting', lastError: null });
        else put(r, { id: h.state.id, status: h.state.status, lastError: h.state.lastError, coreMessage: h.state.coreMessage });
      }
      const cur = receipt(r)!;
      if (cur.id) {
        const st = await r.status(cur.id, lock.govHash);
        statusFailures.delete(r.base);
        if (!st) {
          // the relay lost it (a reset): hand it over again, which is idempotent
          const h = await r.hold(body, lock.govHash);
          if (h.kind === 'held') put(r, { id: h.state.id, status: h.state.status, lastError: h.state.lastError, coreMessage: h.state.coreMessage });
        } else put(r, { status: st.status, lastError: st.lastError, coreMessage: st.coreMessage });
      } else if (cur.legacy && enoughConfs) {
        // a relay without holding: asked at 6 confirmations (it checks Core's own count and says 425 until then)
        const res = await r.submitNow(body);
        if (res.kind === 'submitted') put(r, { status: 'submitted', lastError: null });
        else put(r, { status: 'waiting', lastError: 'collateral-unconfirmed' });
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (definite(code)) {
        // the proposal or its collateral itself is refused: another relay would refuse it too
        put(r, { status: 'failed', lastError: code ?? 'refused', coreMessage: relayErrorText(e) });
        return;
      }
      if (isTransient(e)) {
        const n = (statusFailures.get(r.base) ?? 0) + 1;
        statusFailures.set(r.base, n);
        put(r, { status: n >= MAX_STATUS_FAILURES && code !== 'unknown-collateral' ? 'unreachable' : (receipt(r)?.status ?? 'waiting'), lastError: code ?? 'unreachable', coreMessage: relayErrorText(e) });
        if (n < MAX_STATUS_FAILURES || code === 'unknown-collateral') return; // retried on the next tick
      } else {
        put(r, { status: 'failed', lastError: code ?? 'refused', coreMessage: relayErrorText(e) });
      }
      continue;
    }
    const cur = receipt(r)!;
    if (cur.status === 'submitted') {
      sub.submittedAt = now;
      sub.via = r.name;
      return;
    }
    if (cur.status === 'failed') {
      if (definite(cur.lastError)) return; // Core (or the rules) refused the proposal itself: another relay would too
      continue;
    }
    return; // this relay has it (waiting): nothing more to do this tick
  }
}

/** The user ran `gobject submit` in their own Dash Core. */
export function markManualSubmit(d: ProposalDraft, now = Date.now()): ProposalDraft {
  const sub = cloneSubmission(d);
  sub.submittedAt ??= now;
  sub.via ??= 'manual';
  return { ...d, submission: sub };
}

/** Lets the relays that gave up be tried again (the "Try the relays again" button). */
export function resetRelays(d: ProposalDraft): ProposalDraft {
  statusFailures.clear();
  const sub = cloneSubmission(d);
  sub.relays = sub.relays.filter((r) => r.status !== 'failed' && r.status !== 'unreachable');
  return { ...d, submission: sub };
}
