// The badge scheduler (PLAN §8.5, §8.10; reviews H1/N1, M3), without React: BadgeProvider runs one per identity across tabs
// (Web Locks) and calls tick() every minute, postHeld() before each Platform write of the identity (in the tab that writes) and on
// Register now. Every change is merged into the latest stored jobs under the store lock (env.commit).
//   tick       ends jobs whose window closed (a held token that lapsed), sends at most one token request when the browser's
//              spacing allows (visit.ts: no write and no other request for COOLDOWN_MS), posts Private badges at their height
//              (after the cooldown), and creates renewals. It never posts a held Standard token.
//   postHeld   posts held Standard tokens: with a write (only once the request's cooldown is over), or at once (Register now).
import { clientPostingWindow, epochLength, epochOf, EPOCH_PARAMS, randomBelow, resumeDelayMs, type BadgeNetwork, type EpochParams } from '@govhub/badge';
import { isActive, isHeld, pastDeadline, renewal, requestWindow, step, type BadgeJob, type ClientDeps } from './client.ts';
import type { TrustedIssuer } from './config.ts';
import type { JobStore } from './store.ts';
import { COOLDOWN_MS, drawQuietExtraMs, mayPost, mayRequest, noteIdentityWrite, noteRequestAttempt, noteRequestSent, quietForMs } from './visit.ts';

export const TICK_MS = 60_000;
export type Mutate = (jobs: BadgeJob[]) => BadgeJob[];

/** Jobs whose separation a write from this identity right now would undo: a held Standard token, or any active Private job. */
export const separationAtStake = (jobs: readonly BadgeJob[]): boolean => jobs.some((j) => isHeld(j) || (j.mode === 'private' && isActive(j)));

/** The note during a request's cooldown, when separationAtStake (`left` ms of it). A nudge, not an alarm. */
export function cooldownNote(left: number): string {
  return `Your MN badge request just went out. If you can, wait about ${Math.max(1, Math.ceil(left / 60_000))} min before you post or react: the longer the gap, the harder it is to match your badge to your masternode.`;
}

/**
 * A held Standard token that a newer badge makes useless: another job for the same issuer and a later epoch is posted, or is held
 * and current. Readers show one badge per issuer, so it would only cost a document. Returns the jobs with those ended.
 */
export function supersede(p: EpochParams, jobs: BadgeJob[], height: number): BadgeJob[] {
  return jobs.map((j) => {
    if (!isHeld(j)) return j;
    const newer = jobs.find((x) => x.issuer.identityId === j.issuer.identityId && x.epoch > j.epoch && (x.state === 'posted' || (isHeld(x) && epochOf(p, height) >= x.epoch)));
    if (!newer) return j;
    const { sig: _s, ...rest } = j;
    return { ...rest, state: 'expired' as const, note: `Not needed: your badge for epoch ${newer.epoch} replaces it.` };
  });
}

export interface SchedulerEnv {
  net: BadgeNetwork;
  /** the client's deps; the scheduler counts and marks token requests on their way to the worker */
  deps: ClientDeps;
  store: JobStore;
  /** merges a change into the latest stored jobs (under the store lock) and shows them */
  commit(m: Mutate): Promise<BadgeJob[]>;
  /** Platform's proved core height */
  coreHeight(): Promise<number>;
  onHeight?(height: number): void;
  /** the trust list as it is now */
  trust(): readonly TrustedIssuer[];
  /** a keyring signer is registered for this MN */
  hasSigner(proTxHash: string): boolean;
  /** runs fn under a browser-wide lock of that name */
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** false once signed out or unmounted */
  live(): boolean;
}

export interface Scheduler {
  /** one scheduler round; resolves with the ms until the next */
  tick(): Promise<number>;
  /** resolves with the stored jobs after it (unchanged when nothing was posted) */
  postHeld(o: { id?: string; force: boolean }): Promise<BadgeJob[]>;
}

export function createScheduler(env: SchedulerEnv): Scheduler {
  const p = EPOCH_PARAMS[env.net];
  /** token requests handed to the worker so far (an attempt that sent none undoes its cooldown mark) */
  let sends = 0;
  const deps: ClientDeps = {
    ...env.deps,
    // a token request (it names the masternode) marks this visit (visit.ts); a challenge alone names nothing
    worker: ((call: Parameters<ClientDeps['worker']>[0]) => {
      if (call.kind === 'token') {
        sends++;
        noteRequestSent();
      }
      return env.deps.worker(call as never);
    }) as ClientDeps['worker'],
  };
  /** Steps one job and records the result in `updates` when it changed anything. */
  const advance = async (updates: Map<string, BadgeJob>, j: BadgeJob, height: number, o?: { post?: boolean }): Promise<void> => {
    const after = await step(deps, j, height, o);
    if (JSON.stringify(after) !== JSON.stringify(j)) updates.set(j.id, after);
  };
  /**
   * Saves what a run computed from `snapshot`: an update only lands on a job still exactly as it was read (another tab, a
   * write's badge post or Register now may have moved it meanwhile; the next tick redoes it then), plus new renewal jobs.
   */
  const merge = (snapshot: readonly BadgeJob[], updates: Map<string, BadgeJob>, height: number, extra: Mutate = (x) => x) =>
    env.commit((latest) => {
      const before = new Map(snapshot.map((j) => [j.id, JSON.stringify(j)]));
      const merged = latest.map((j) => {
        const u = updates.get(j.id);
        return u && before.get(j.id) === JSON.stringify(j) ? u : j;
      });
      return supersede(p, extra(merged), height);
    });

  /**
   * Posts held Standard tokens (PLAN §8.10): with a write of this identity (`force` false: only once the cooldown after the last
   * request is over), or Register now (`force`, one job). Under the activity lock, so it cannot interleave with a request in
   * another tab; from the latest stored jobs, so two tabs cannot post the same token twice.
   */
  const postHeld = (o: { id?: string; force: boolean }) =>
    env.lock('govhub-badge-activity', async () => {
      if (!env.live()) return [];
      const snapshot = await env.store.load();
      if (!o.force && !mayPost()) return snapshot;
      const held = snapshot.filter((j) => isHeld(j) && (o.id === undefined || j.id === o.id));
      if (!held.length) return snapshot;
      const height = await env.coreHeight();
      // one badge per issuer: the newest held token that is current (an older one is superseded when saved)
      const pick = new Map<string, BadgeJob>();
      for (const j of supersede(p, snapshot, height).filter((x) => isHeld(x) && held.some((h) => h.id === x.id) && epochOf(p, height) >= x.epoch)) {
        const cur = pick.get(j.issuer.identityId);
        if (!cur || j.epoch > cur.epoch) pick.set(j.issuer.identityId, j);
      }
      const updates = new Map<string, BadgeJob>();
      for (const j of pick.values()) {
        if (!env.live()) return snapshot;
        await advance(updates, j, height, { post: true });
      }
      return merge(snapshot, updates, height);
    });

  const notBefore = new Map<string, number>();
  /** the extra quiet of jobs saved before it was stored with them: drawn once per tab */
  const drawn = new Map<string, number>();
  const quietNeeded = (j: BadgeJob): number => {
    if (j.quietExtraMs === undefined && !drawn.has(j.id)) drawn.set(j.id, drawQuietExtraMs(() => randomBelow(2 ** 32)));
    return COOLDOWN_MS + (j.quietExtraMs ?? drawn.get(j.id)!);
  };
  let okTicks = 0;
  const tick = async (): Promise<number> => {
    const height = await env.coreHeight();
    if (!env.live()) return TICK_MS;
    env.onHeight?.(height);
    const snapshot = await env.store.load(); // other tabs may have added jobs
    if (!env.live()) return TICK_MS;
    const updates = new Map<string, BadgeJob>();
    const added: BadgeJob[] = [];
    const run = (j: BadgeJob) => advance(updates, j, height);
    // windows that closed, lapsed held tokens: no network involved
    for (const j of snapshot.filter((x) => isActive(x) && pastDeadline(p, x, height))) await run(j);
    // due: requests whose height came, Private posts whose height came. A held Standard token is never due here.
    const due = snapshot.filter(
      (j) => isActive(j) && !updates.has(j.id) && (j.state === 'scheduled' ? height >= j.requestAt : j.mode === 'private' && height >= (j.postAt ?? clientPostingWindow(p, j.epoch).from)),
    );
    // An action found on the first tick of a visit waits a random 30 s - 10 min, so it is not tied to the page load (L1: the
    // first SUCCESSFUL tick). One that becomes due later in the visit goes as soon as its spacing allows.
    for (const j of due) {
      if (notBefore.has(j.id)) continue;
      const end = j.state === 'scheduled' ? requestWindow(p, j.epoch, j.mode).to : clientPostingWindow(p, j.epoch).to;
      const leftMs = Math.max(0, end - height) * 150_000;
      notBefore.set(j.id, Date.now() + (okTicks === 0 ? resumeDelayMs(Math.min(600_000, leftMs / 2)) : 0));
    }
    // a job whose last attempt failed waits its backoff (retryAt), so it does not monopolise visits
    const ready = due.filter((j) => Date.now() >= notBefore.get(j.id)! && Date.now() >= (j.retryAt ?? 0));
    // only requests that can actually go out now (trusted issuer, a signer): one that would wait must not hold up posts (N2)
    const sendable = ready.filter((j) => j.state === 'scheduled' && deps.trusted(j.issuer.identityId) && (j.signer.kind === 'wif' || env.hasSigner(j.proTxHash)));
    // and only after the quiet half hour plus this job's random extra, so it does not line up with the last write (visit.ts)
    // (also checked under the lock below, against the latest marks)
    const quiet = quietForMs();
    const requests = sendable.filter((j) => quiet >= quietNeeded(j)).sort((a, b) => requestWindow(p, a.epoch, a.mode).to - requestWindow(p, b.epoch, b.mode).to);
    // only posts that can go out: a post for an untrusted issuer would mark a write every tick and starve requests (round 4)
    const posts = ready.filter((j) => j.state === 'token' && deps.trusted(j.issuer.identityId));
    // H1/N1: Private posts first (finite: one per issuer and epoch), and only once the cooldown after the last request is over;
    // otherwise one token request, either mode (the one whose window closes first), only when nothing was written and nothing
    // requested in this browser for the cooldown. The check and the mark happen under a browser-wide lock, so two tabs cannot
    // both pass it (round 3 L1).
    await env.lock(
      'govhub-badge-activity',
      async () => {
        if (!env.live()) return;
        if (posts.length && mayPost()) {
          noteIdentityWrite(); // before the post path's reads: the write is on its way
          for (const j of posts) await run(j);
        } else if (requests.length && mayRequest() && quietForMs() >= quietNeeded(requests[0]!)) {
          const undo = noteRequestAttempt();
          const sent = sends;
          await run(requests[0]!);
          // nothing named the masternode to the issuer (it was unreachable): no cooldown for nothing (D-046)
          if (sends === sent) undo();
        }
      },
    );
    if (!env.live()) return TICK_MS;
    // renewals: create the next epoch's job (no network to the issuer; blinding only)
    const current = () => snapshot.map((j) => updates.get(j.id) ?? j).concat(added);
    const sourceOf = new Map<string, string>(); // renewal job id -> the job whose kept key it takes
    for (const j of current()) {
      const issuer = env.trust().find((t) => t.identityId === j.issuer.identityId && t.enabled);
      if (!issuer) continue;
      const r = await renewal(deps, current(), j, height, issuer);
      if (r) {
        added.push(r);
        sourceOf.set(r.id, j.id);
      }
    }
    if (!env.live()) return TICK_MS;
    const keepFrom = Math.floor(height / epochLength(p)) - 2;
    await merge(snapshot, updates, height, (merged) => {
      // a renewal made from an older snapshot must not duplicate a job added meanwhile for the same issuer and epoch (N11)
      const fresh = added.filter((a) => !merged.some((j) => j.id === a.id || (j.issuer.identityId === a.issuer.identityId && j.epoch === a.epoch && j.state !== 'failed' && j.state !== 'expired')));
      // the kept voting key moves to a renewal job only if that job is kept (round 3 L4)
      const handedOver = new Set(fresh.map((a) => sourceOf.get(a.id)));
      return merged
        .map((j) => (handedOver.has(j.id) && j.signer.kind === 'wif' ? { ...j, signer: { kind: 'external' as const }, proTxHash: '' } : j))
        .concat(fresh)
        .filter((j) => isActive(j) || j.epoch >= keepFrom);
    });
    okTicks++;
    // sooner only for a job about to become ready (its resume delay); jobs in backoff wait for the normal tick
    const soon = due.filter((j) => !updates.has(j.id)).map((j) => Math.max(notBefore.get(j.id) ?? 0, j.retryAt ?? 0) - Date.now());
    // a request waiting only for the spacing goes as soon as its quiet time is reached
    const spacing = sendable.filter((j) => !updates.has(j.id)).map((j) => quietNeeded(j) - quiet + 1_000);
    const next = Math.min(TICK_MS, ...soon.filter((ms) => ms > 0), ...spacing.filter((ms) => ms > 0));
    return Math.max(5_000, next);
  };
  return { tick, postHeld };
}
