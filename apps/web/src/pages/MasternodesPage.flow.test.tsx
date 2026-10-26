// @vitest-environment happy-dom
// "Add your masternodes" as one flow with the MN badge: paste the key once, see its masternodes, confirm (saved or memory only,
// badge on or off). The keyring and the badge provider are fakes; the badge logic in between (badge/flow.ts: readiness from the
// issuer's keys, status, the request's epoch) is the real one.
import { emptyKeyring, type OpenedKeyring } from '@govhub/auth';
import { encodeWif } from '@govhub/verify';
import { act, useSyncExternalStore } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BadgeJob } from '../badge/client.ts';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import { button, click, flush, render, type } from '../test/render.tsx';
import { parseVotingKey, votingKeyInfos, type OwnedMasternode } from '../voting/masternodes.ts';

/** A tiny store the mocked hooks read with useSyncExternalStore, so a change re-renders like a provider would. */
function store<T>(init: T) {
  let v = init;
  const ls = new Set<() => void>();
  return {
    get: () => v,
    set: (p: Partial<T>) => {
      v = { ...v, ...p };
      ls.forEach((l) => l());
    },
    reset: (n: T) => {
      v = n;
    },
    sub: (l: () => void) => (ls.add(l), () => ls.delete(l)),
  };
}

const IDENTITY = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
const ISSUER = { name: 'govhub', identityId: 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH', url: 'https://gov-issuer-testnet.dashhq.org', enabled: true };
const HEIGHT = 1_579_259; // epoch 2741 on testnet (576 blocks); 2742 starts at 1,579,392
const WIF = encodeWif(fixtureMnKey(1), true, 'testnet');
const PRO = 'ab'.repeat(32);

const h = vi.hoisted(() => ({ kr: null as unknown as ReturnType<typeof store<any>>, bd: null as unknown as ReturnType<typeof store<any>> }));

vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => useSyncExternalStore(h.kr.sub, h.kr.get) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: () => {}, session: h.kr.get().session }) }));
const app = vi.hoisted(() => ({ registry: { platformNetwork: 'testnet', coreNetwork: 'testnet' }, mode: 'live' }));
vi.mock('../app/context.tsx', () => ({ useApp: () => app }));
const forum = vi.hoisted(() => ({ session: { identityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv' } })); // stable, like the provider's
vi.mock('../app/forum.tsx', () => ({ useForum: () => forum }));
vi.mock('../badge/context.tsx', () => ({
  useBadgeCtx: () => useSyncExternalStore(h.bd.sub, h.bd.get),
  useBadges: () => ({ byOwner: useSyncExternalStore(h.bd.sub, h.bd.get).shown, live: true, loading: false }),
}));
vi.mock('../ui/vote/VotesList.tsx', () => ({ VotesList: () => null }));
vi.mock('../ui/vote/AddPasskey.tsx', () => ({ AddPasskey: () => null }));
vi.mock('../ui/SignIn.tsx', () => ({ openSignIn: () => {} }));

const { MasternodesPage } = await import('./MasternodesPage.tsx');

const mn = (keyIndex: number, valid = true): OwnedMasternode => ({
  proTxHash: PRO,
  collateralTxid: 'cd'.repeat(32),
  collateralIndex: 0,
  type: 'regular',
  valid,
  votingAddress: '',
  keyIndex,
  provenance: { key: 'sml', collateral: 'protx' },
});

/** The keyring fake: createKeyring opens a memory-only keyring; addKey parses the key into it and the lookup finds one masternode. */
function keyringFake(o: { canSave?: boolean } = {}) {
  let ring: OpenedKeyring | null = null;
  const calls = { create: [] as boolean[], add: [] as string[], save: 0, remove: 0 };
  const set = (p: object) => h.kr.set(p);
  const ctx = {
    status: 'absent',
    error: null,
    needsTopUp: false,
    dismissError: () => set({ error: null, needsTopUp: false }),
    demo: false,
    memoryOnly: false,
    keyring: null,
    keyInfos: [],
    busy: null,
    mns: { phase: 'idle', owned: [], missing: [], mismatch: [], smlNodes: 0, forKeys: '' },
    coreNetwork: 'testnet',
    session: { wallet: o.canSave === false ? undefined : {} },
    refreshMasternodes: () => {},
    lock: () => {},
    createKeyring: async (memory: boolean) => {
      calls.create.push(memory);
      ring = emptyKeyring(IDENTITY, []);
      set({ status: 'open', memoryOnly: memory, keyring: ring });
    },
    addKey: async (input: string, label: string) => {
      calls.add.push(input);
      const { privateKey, compressed } = parseVotingKey(input, 'testnet');
      ring!.content.keys.push({ privateKey, compressed, label });
      const keyInfos = votingKeyInfos(ring!.content.keys);
      const forKeys = keyInfos.map((k) => k.keyId).join(',');
      set({ keyInfos, mns: { phase: 'loading', owned: [], missing: [], mismatch: [], smlNodes: 0, forKeys } });
      setTimeout(() => set({ mns: { phase: 'ready', owned: [mn(0)], missing: [], mismatch: [], smlNodes: 3, forKeys } }), 0);
      return keyInfos[0]!.keyId;
    },
    removeKey: async () => {
      calls.remove++;
    },
    saveToPlatform: async () => {
      calls.save++;
      set({ memoryOnly: false });
    },
  };
  h.kr = store<any>(ctx);
  return calls;
}

/** The badge provider fake: an issuer whose first key is for `firstKey`; requestBadge records the call and adds a job. */
function badgeFake(o: { firstKey?: number; shown?: string[]; jobs?: BadgeJob[]; requestWait?: number; postWait?: number; height?: number } = {}) {
  const calls = { request: [] as Array<{ voting: unknown; pro: string; opts: any }>, remove: [] as string[], retry: [] as string[], register: [] as string[] };
  const firstKey = o.firstKey ?? 2741;
  const ctx = {
    contractId: 'contract',
    trust: [ISSUER],
    reader: {
      coreHeight: async () => HEIGHT,
      key: async (_i: unknown, e: number) => (e >= firstKey ? { key: { revokedFrom: null }, problem: null } : { key: null, problem: 'no issuerKey for this epoch' }),
    },
    jobs: o.jobs ?? [],
    coreHeight: o.height ?? HEIGHT,
    requestWait: o.requestWait ?? 0,
    postWait: o.postWait ?? 0,
    registerNow: async (id: string) => {
      calls.register.push(id);
      h.bd.set({ jobs: h.bd.get().jobs.map((j: BadgeJob) => (j.id === id ? { ...j, state: 'posted' } : j)) });
    },
    privacy: 'standard',
    setPrivacy: (m: string) => h.bd.set({ privacy: m }),
    shown: new Map(o.shown ? [[IDENTITY, o.shown]] : []),
    requestBadge: async (voting: unknown, pro: string, opts: any) => {
      calls.request.push({ voting, pro, opts });
      const epoch = opts.epoch ?? 2741;
      const job = { id: `j${calls.request.length}`, issuer: ISSUER, epoch, mode: opts.mode, state: 'scheduled', requestAt: opts.epoch ? epoch * 576 : HEIGHT, attempts: 0, net: 'testnet', signer: { kind: 'wif', wif: '(stored encrypted)' } } as unknown as BadgeJob;
      h.bd.set({ jobs: [...h.bd.get().jobs, job] });
      return job;
    },
    removeJob: (id: string) => (calls.remove.push(id), h.bd.set({ jobs: h.bd.get().jobs.filter((j: BadgeJob) => j.id !== id) })),
    retryJob: (id: string) => calls.retry.push(id),
  };
  h.bd = store<any>(ctx);
  return calls;
}

const page = () => (
  <MemoryRouter>
    <MasternodesPage />
  </MemoryRouter>
);
const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The scheduler moved the job on. */
const setJob = (p: Partial<BadgeJob>) => act(async () => h.bd.set({ jobs: h.bd.get().jobs.map((j: BadgeJob) => ({ ...j, ...p })) }));

/** Paste the key and find its masternodes: the flow's step 2. */
async function pasteAndFind(el: HTMLElement) {
  const inputs = el.querySelectorAll('input[type="password"]');
  expect(inputs).toHaveLength(1); // the only place the key is pasted
  await type(inputs[0] as HTMLInputElement, WIF);
  await click(q(el, 'flow-find')!);
  await flush();
  await flush();
  expect(q(el, 'flow-mns')?.textContent).toContain('votes for 1 masternode');
  expect(el.querySelectorAll('input[type="password"]')).toHaveLength(0);
}

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  document.body.innerHTML = '';
});

async function start() {
  const r = await render(page());
  unmount = r.unmount;
  await flush();
  return r.el;
}

describe('Add your masternodes: one flow with the MN badge', () => {
  it('badge on, issuer issuing now, saved: one paste, one Platform save, one badge request with the same key; nothing of the key left on the page', async () => {
    const kr = keyringFake();
    const bd = badgeFake();
    const el = await start();
    expect(q(el, 'add-flow')?.textContent).toContain('Paste a masternode voting key once');
    await pasteAndFind(el);
    expect((q(el, 'mnb-toggle') as HTMLInputElement).checked).toBe(true); // on by default
    expect(q(el, 'mnb-ready')?.dataset.state).toBe('now');
    expect(q(el, 'mnb-choice')?.textContent).toContain('never which masternode or how many');
    expect(q(el, 'flow-store')?.textContent).toContain('Saved encrypted on Platform');
    expect(q(el, 'flow-store')?.textContent).toContain('About 0.003 DASH');
    expect(q(el, 'flow-confirm')?.textContent).toBe('Add 1 masternode and get the badge');
    await click(q(el, 'flow-confirm')!);
    await flush();

    expect(kr.create).toEqual([true]); // a memory-only keyring first, saved once at confirm
    expect(kr.add).toEqual([WIF]);
    expect(kr.save).toBe(1);
    expect(bd.request).toHaveLength(1);
    expect(bd.request[0]).toMatchObject({ voting: WIF, pro: PRO, opts: { mode: 'standard', keepKey: false, issuer: ISSUER } });
    expect(bd.request[0]!.opts.epoch).toBeUndefined();
    // the pasted text is gone from the page
    expect([...el.querySelectorAll('input')].some((i) => i.value.includes(WIF))).toBe(false);
    expect(el.innerHTML).not.toContain(WIF);

    expect(q(el, 'flow-done')?.textContent).toContain('key saved encrypted on Platform');
    expect(q(el, 'mnb-pending')?.dataset.state).toBe('requesting');
    // the scheduler posts it: the success card, with the chip as readers see it
    await setJob({ state: 'posted' });
    expect(q(el, 'mnb-success')?.textContent).toContain('Your MN badge is live');
    expect(q(el, 'mnb-success')?.textContent).toContain('MN · vouched by govhub');
    // the keyring card under it says so too
    expect(q(el, 'mnb-summary')?.textContent).toBe('shown');
  });

  it('a save that merges into an existing saved keyring (closing the memory one) still requests the badge with the key taken before', async () => {
    keyringFake();
    const bd = badgeFake();
    const el = await start();
    await pasteAndFind(el);
    const save = h.kr.get().saveToPlatform;
    h.kr.set({
      saveToPlatform: async () => {
        await save();
        h.kr.get().keyring.content.keys.forEach((k: { privateKey: Uint8Array }) => k.privateKey.fill(0)); // opened(existing) closed this one
      },
    });
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(bd.request).toHaveLength(1);
    expect(bd.request[0]!.voting).toBe(WIF);
    expect(q(el, 'flow-badge-note')).toBeNull();
  });

  it('badge off: the masternodes are added and nothing is requested', async () => {
    keyringFake();
    const bd = badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await click(q(el, 'mnb-toggle')!);
    expect(q(el, 'mnb-ready')).toBeNull();
    expect(q(el, 'flow-confirm')?.textContent).toBe('Add 1 masternode');
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(bd.request).toHaveLength(0);
    expect(q(el, 'flow-badge-off')?.textContent).toContain('MN badge: off');
    expect(q(el, 'mnb-summary')?.textContent).toBe('not shown');
  });

  it('F5: after a save fails for credits, choosing memory only clears "Nothing was saved. Top up" and the confirm goes through', async () => {
    const kr = keyringFake();
    badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await act(async () =>
      h.kr.set({
        saveToPlatform: async () => {
          kr.save++;
          h.kr.set({ error: 'Your identity has 0.00193633 DASH, and saving the keyring on Platform needs about 0.003 DASH. Top up the identity (menu, Top up), then try again. Nothing was saved.', needsTopUp: true });
          throw new Error('top up');
        },
      }),
    );
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(q(el, 'keyring-error')?.textContent).toContain('Nothing was saved.');
    expect(q(el, 'keyring-topup')).toBeTruthy();
    // memory only instead: the error is about saving, so it goes away at once
    await click(q(el, 'flow-dont-save')!);
    expect(q(el, 'keyring-error')).toBeNull();
    expect(q(el, 'keyring-topup')).toBeNull();
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(kr.save).toBe(1); // not tried again
    expect(q(el, 'flow-done')?.textContent).toContain('key in memory only');
    expect(q(el, 'keyring-error')).toBeNull();
  });

  it('F5: an error that is not about credits stays when memory only is chosen', async () => {
    keyringFake();
    badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await act(async () => h.kr.set({ error: 'The keyring locked itself after being idle.', needsTopUp: false }));
    await click(q(el, 'flow-dont-save')!);
    expect(q(el, 'keyring-error')?.textContent).toContain('locked itself');
  });

  it('memory only: no Platform save, and the copy says the badge request keeps its own encrypted copy until sent', async () => {
    const kr = keyringFake();
    const bd = badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await click(q(el, 'flow-dont-save')!);
    expect(q(el, 'flow-store')?.textContent).toContain('Memory only.');
    expect(q(el, 'flow-store')?.textContent).toContain('keeps its own copy of the key in this browser, never in plain text, until it is sent');
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(kr.save).toBe(0);
    expect(bd.request).toHaveLength(1);
    expect(q(el, 'flow-done')?.textContent).toContain('key in memory only');
    expect(q(el, 'flow-done')?.textContent).toContain('except the badge request’s own copy');
    expect(q(el, 'keyring-status')?.textContent).toContain('nothing is saved but the pending badge request’s key copy');
  });

  it('a session that cannot save: memory only is chosen and saving is explained', async () => {
    keyringFake({ canSave: false });
    badgeFake();
    const el = await start();
    await pasteAndFind(el);
    const box = q(el, 'flow-dont-save') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(q(el, 'flow-store')?.textContent).toContain('Saving needs your recovery phrase');
  });

  it('issuer not ready: says from which block, schedules for that epoch, advances only while signed in here, and can be cancelled', async () => {
    keyringFake();
    const bd = badgeFake({ firstKey: 2742 });
    const el = await start();
    await pasteAndFind(el);
    const ready = q(el, 'mnb-ready')!;
    expect(ready.dataset.state).toBe('later');
    expect(ready.textContent).toContain('Your badge will be issued automatically from block 1,579,392 (in about 6 hours)');
    expect(ready.textContent).toContain('signed in as this identity with the same sign-in key');
    expect(ready.textContent).toContain('cancel');
    expect(ready.textContent).not.toContain('Switch it on'); // the switch is on here
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(bd.request[0]!.opts).toMatchObject({ mode: 'standard', epoch: 2742 });
    const pending = q(el, 'mnb-pending')!;
    expect(pending.dataset.state).toBe('scheduled');
    expect(pending.textContent).toContain('it will be issued automatically from block 1,579,392');
    expect(pending.textContent).toContain('signed in as this identity');
    expect(q(el, 'mnb-summary')?.textContent).toBe('pending (from block 1,579,392)');
    await click(q(el, 'mnb-cancel')!);
    expect(bd.remove).toEqual(['j1']);
    expect(q(el, 'mnb-cancelled')?.textContent).toContain('the voting key stored with it are deleted from this browser');
    expect(q(el, 'mnb-summary')?.textContent).toBe('not shown');
  });

  it('issuer not issuing at all yet: says so plainly, and the masternodes are still added without a request', async () => {
    keyringFake();
    const bd = badgeFake({ firstKey: 9999 });
    const el = await start();
    await pasteAndFind(el);
    expect(q(el, 'mnb-ready')?.dataset.state).toBe('blocked');
    expect(q(el, 'mnb-ready')?.textContent).toContain('isn’t issuing badges yet');
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(bd.request).toHaveLength(0);
    expect(q(el, 'flow-badge-note')?.textContent).toContain('not requested');
  });

  it('issuer unreachable: a plain message with the next try, Try again now, and Cancel; the raw error only under Details', async () => {
    keyringFake();
    const bd = badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await click(q(el, 'flow-confirm')!);
    await flush();
    await setJob({ attempts: 1, note: 'Could not reach the issuer: gov-issuer-testnet.dashhq.org could not be reached (Failed to fetch).', retryAt: Date.now() + 3_600_000 });
    await flush();
    const p = q(el, 'mnb-pending')!;
    expect(p.dataset.state).toBe('unreachable');
    expect(p.textContent).toContain('can’t be reached right now');
    expect(p.textContent).toContain('tried again around');
    expect(p.querySelector('details')?.open).toBe(false);
    await click(q(el, 'mnb-retry')!);
    expect(bd.retry).toEqual(['j1']);
    expect(q(el, 'mnb-cancel')).not.toBeNull();
  });

  it('already badged (one badge per issuer): shown as done, and no second request', async () => {
    keyringFake();
    const bd = badgeFake({ shown: ['govhub'] });
    const el = await start();
    await pasteAndFind(el);
    expect(q(el, 'flow-confirm')?.textContent).toBe('Add 1 masternode');
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(bd.request).toHaveLength(0);
    expect(q(el, 'mnb-shown')?.textContent).toContain('already showing');
  });

  it('"Use a different key" removes the key and goes back to the paste step', async () => {
    const kr = keyringFake();
    badgeFake();
    const el = await start();
    await pasteAndFind(el);
    await click(button(el, /Use a different key/));
    await flush();
    expect(kr.remove).toBe(1);
    expect(el.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });
});

describe('a locked keyring (or a pasted-key sign-in)', () => {
  it('"Use memory-only keys instead" starts the same flow, memory only, with the badge; Back returns to unlocking', async () => {
    const kr = keyringFake();
    const bd = badgeFake();
    h.kr.set({ status: 'locked' });
    const el = await start();
    await click(q(el, 'unlock-memory-only')!);
    expect(q(el, 'add-flow')).not.toBeNull();
    await click(button(el, /Back to unlocking/));
    expect(q(el, 'add-flow')).toBeNull();
    await click(q(el, 'unlock-memory-only')!);
    await pasteAndFind(el);
    const box = q(el, 'flow-dont-save') as HTMLInputElement;
    expect(box.checked && box.disabled).toBe(true);
    expect(q(el, 'flow-store')?.textContent).toContain('unlock it first');
    await click(q(el, 'flow-confirm')!);
    await flush();
    expect(kr.create).toEqual([true]);
    expect(kr.save).toBe(0);
    expect(bd.request).toHaveLength(1);
  });
});

describe('deferred Standard in the unified flow (PLAN §8.10)', () => {
  it('after the keyring save, the request waits about 30 min (said once, plainly); then the badge is held for the next post, with Register now', async () => {
    keyringFake();
    const bd = badgeFake({ requestWait: 30 * 60_000 });
    const el = await start();
    await pasteAndFind(el);
    expect(q(el, 'mnb-ready')?.textContent).toContain('Your badge is fetched in the background and appears the next time you post or react.');
    await click(q(el, 'flow-confirm')!);
    await flush();
    const p = q(el, 'mnb-pending')!;
    expect(p.dataset.state).toBe('fetch-wait');
    expect(p.textContent).toContain('We’ll fetch your badge in about 30 minutes so the request can’t be matched to your account.');
    expect(q(el, 'mnb-summary')?.textContent).toBe('fetching in ~30 min');
    // the token arrives (30 min later): held, not posted
    await act(async () => h.bd.set({ requestWait: 0, postWait: 29 * 60_000 }));
    await setJob({ state: 'token', sig: 'held', attempts: 1 });
    const held = q(el, 'mnb-held')!;
    expect(held.dataset.state).toBe('ready');
    expect(held.textContent).toContain('Your MN badge is ready. It will appear the next time you post or react after about');
    expect(held.textContent).toContain('The longer you wait, the harder it is for anyone to match it to your masternode.');
    expect(held.textContent).toContain('posting from another device won’t publish it');
    expect(q(el, 'mnb-register-note')?.textContent).toBe(
      'Posting now lets govhub’s issuer match your masternode to this account by timing. Waiting until you next post or react hides that better; the longer the gap, the better.',
    );
    expect(q(el, 'mnb-lapsing')).toBeNull();
    expect(q(el, 'mnb-summary')?.textContent).toBe('ready, appears with your next post');
    await act(async () => h.bd.set({ postWait: 0 }));
    expect(q(el, 'mnb-held')?.textContent).toContain('It will appear the next time you post or react.');
    // Register now: posted at once, the success card
    await click(q(el, 'mnb-register-now')!);
    await flush();
    expect(bd.register).toEqual(['j1']);
    expect(q(el, 'mnb-success')?.textContent).toContain('Your MN badge is live');
    expect(q(el, 'mnb-summary')?.textContent).toBe('shown');
  });

});

describe('the keyring card: MN badge row for existing keyrings', () => {
  function openKeyring() {
    const ring = emptyKeyring(IDENTITY, []);
    ring.content.keys.push({ privateKey: fixtureMnKey(1).slice(), compressed: true, label: 'rack 1' });
    keyringFake();
    const keyInfos = votingKeyInfos(ring.content.keys);
    h.kr.set({ status: 'open', keyring: ring, keyInfos, mns: { phase: 'ready', owned: [mn(0)], missing: [], mismatch: [], smlNodes: 3, forKeys: keyInfos[0]!.keyId } });
  }

  it('not shown: the switch asks now with a keyring key (no paste), and switching off a pending request cancels it', async () => {
    openKeyring();
    const bd = badgeFake();
    const el = await start();
    expect(q(el, 'add-flow')).toBeNull();
    expect(q(el, 'mnb-summary')?.textContent).toBe('not shown');
    await click(q(el, 'mnb-row-toggle')!);
    await flush();
    expect(bd.request).toHaveLength(1);
    expect(bd.request[0]).toMatchObject({ voting: WIF, pro: PRO });
    expect(q(el, 'mnb-summary')?.textContent).toBe('pending (being issued)');
    await click(q(el, 'mnb-row-toggle')!);
    expect(bd.remove).toEqual(['j1']);
  });

  it('shown: the switch is on and cannot remove it; says badges are permanent', async () => {
    openKeyring();
    badgeFake({ shown: ['govhub'] });
    const el = await start();
    const t = q(el, 'mnb-row-toggle') as HTMLInputElement;
    expect(t.checked).toBe(true);
    expect(t.disabled).toBe(true);
    expect(q(el, 'mnb-immutable')?.textContent).toContain('can’t be removed or switched off');
  });

  it('pending from a later block: summary says so', async () => {
    openKeyring();
    badgeFake({ firstKey: 2742, jobs: [{ id: 'x', issuer: ISSUER, epoch: 2742, mode: 'standard', state: 'scheduled', requestAt: 2742 * 576, attempts: 0, signer: { kind: 'wif', wif: '(stored encrypted)' } } as unknown as BadgeJob] });
    const el = await start();
    expect(q(el, 'mnb-summary')?.textContent).toBe('pending (from block 1,579,392)');
    expect((q(el, 'mnb-row-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('not shown, issuer not ready: offers to schedule it from the block', async () => {
    openKeyring();
    badgeFake({ firstKey: 2742 });
    const el = await start();
    await flush();
    expect(q(el, 'mnb-ready')?.textContent).toContain('Switch it on and your badge will be issued automatically from block 1,579,392');
  });
  const heldJob = { id: 'h', issuer: ISSUER, epoch: 2741, mode: 'standard', state: 'token', sig: 'held', requestAt: HEIGHT, attempts: 1, net: 'testnet', signer: { kind: 'external' } } as unknown as BadgeJob;

  it('held: "ready, appears with your next post", the nudge, Register now with its note, and Cancel; switching off cancels too', async () => {
    openKeyring();
    const bd = badgeFake({ jobs: [heldJob] });
    const el = await start();
    expect(q(el, 'mnb-summary')?.textContent).toBe('ready, appears with your next post');
    expect((q(el, 'mnb-row-toggle') as HTMLInputElement).checked).toBe(true);
    expect(q(el, 'mnb-held')?.dataset.state).toBe('ready');
    expect(q(el, 'mnb-lapsing')).toBeNull();
    expect(q(el, 'mnb-register-note')?.textContent).toContain('the longer the gap, the better');
    await click(q(el, 'mnb-row-toggle')!);
    expect(bd.remove).toEqual(['h']);
  });

  it('held near its end: "will lapse in N" with Register now; Register now posts it ("shown")', async () => {
    openKeyring();
    // epoch 2741's token lapses at S(2742) + 72 - 3 = 1,579,461; 30 blocks before is inside the 58-block nudge
    const bd = badgeFake({ height: 1_579_431, jobs: [heldJob] });
    const el = await start();
    expect(q(el, 'mnb-summary')?.textContent).toBe('will lapse in 1 hour');
    expect(q(el, 'mnb-lapsing')?.textContent).toBe('Your badge will lapse in 1 hour unless registered.');
    expect(q(el, 'mnb-held')?.dataset.state).toBe('lapsing');
    await click(q(el, 'mnb-register-now')!);
    await flush();
    expect(bd.register).toEqual(['h']);
    expect(q(el, 'mnb-summary')?.textContent).toBe('shown');
  });

  it('fetching: the request waits for the spacing after a write: "fetching in ~N min"', async () => {
    openKeyring();
    badgeFake({ requestWait: 12 * 60_000, jobs: [{ ...heldJob, state: 'scheduled', sig: undefined }] as BadgeJob[] });
    const el = await start();
    expect(q(el, 'mnb-summary')?.textContent).toBe('fetching in ~12 min');
    expect(q(el, 'mnb-pending')?.textContent).toContain('We’ll fetch your badge in about 12 minutes');
  });
});
