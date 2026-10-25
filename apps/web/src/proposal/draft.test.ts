// Draft persistence and the backup file: everything needed to resubmit survives a reload and a device change; a backup that was
// altered, damaged or is for the other network is refused with a reason.
import { checkNewProposal, lockProposal } from '@govhub/verify';
import { describe, expect, it } from 'vitest';
import { backupFile, BackupError, backupMilestone, coreCommands, draftStage, draftStore, mergeDraft, newDraft, nextDepositIndex, payNowProblem, readBackup, type DraftLock, type ProposalDraft } from './draft.ts';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const now = 1_792_800_000;
function locked(network: 'mainnet' | 'testnet' = 'mainnet'): ProposalDraft {
  const addr = network === 'mainnet' ? 'XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62' : 'yXGeNPQXYFXhLAN1ZKrAjxzzBnZ2JZNKnh';
  const c = checkNewProposal({ network, name: 'draft-test', paymentAddress: addr, paymentDuffs: 1_250_000_000n, url: 'https://example.org/draft-test', startEpoch: now, endEpoch: now + 30 * 86400, now });
  expect(c.errors).toEqual([]);
  const l = lockProposal(c.dataHex!, now + 5);
  const lock: DraftLock = {
    ...l, name: 'draft-test', url: 'https://example.org/draft-test', paymentAddress: addr, paymentDuffs: '1250000000', startEpoch: now, endEpoch: now + 30 * 86400, superblocks: [2_575_480], eligible: [2_575_480], lockedAt: now * 1000,
  };
  return { ...newDraft(network, now * 1000), lock, editStep: 2 };
}

describe('draft store', () => {
  it('saves, lists per network newest first, loads, removes; ignores junk', () => {
    const st = memStorage();
    const s = draftStore(st);
    const a = newDraft('mainnet', 1);
    const b = { ...newDraft('testnet', 2) };
    s.save(a);
    s.save(b);
    st.setItem('govhub.proposalDraft.zzzz', '{bad json');
    st.setItem('govhub.proposalDraft.0000000000000000', JSON.stringify({ v: 2 }));
    expect(s.list('mainnet').map((d) => d.id)).toEqual([a.id]);
    expect(s.list().length).toBe(2);
    expect(s.load(a.id)!.inputs).toEqual(a.inputs);
    s.remove(a.id);
    expect(s.load(a.id)).toBeNull();
  });

  it('a save that fails throws (the caller must not pay then)', () => {
    const st = memStorage();
    st.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    expect(() => draftStore(st).save(newDraft('mainnet'))).toThrow(/quota/);
  });

  it('stages', () => {
    const d = locked();
    expect(draftStage(newDraft('mainnet'))).toBe('edit');
    expect(draftStage(d)).toBe('pay');
    expect(draftStage({ ...d, payment: { method: 'core', txid: 'ab'.repeat(32) } })).toBe('submit');
    expect(draftStage({ ...d, payment: { method: 'core', txid: 'ab'.repeat(32) }, submission: { relays: [], publishedAt: 1 } })).toBe('done');
  });
});

describe('backup file', () => {
  it('round-trips a locked draft and carries the Core commands; no secrets', () => {
    const d = { ...locked(), payment: { method: 'core' as const, txid: 'cd'.repeat(32) } };
    const f = backupFile(d);
    expect(f.name).toMatch(/^govhub-proposal-draft-test-[0-9a-f]{8}-paid\.json$/);
    const o = JSON.parse(f.text);
    expect(o.commands).toEqual(coreCommands(d));
    expect(o.commands.submit).toBe(`gobject submit 0 1 ${d.lock!.time} ${d.lock!.dataHex} ${'cd'.repeat(32)}`);
    expect(o.govHash).toBe(d.lock!.govHash);
    expect(readBackup(f.text, 'mainnet')).toEqual(d);
    expect(f.text).not.toMatch(/privateKey|"phrase"|wif/i);
  });

  it('before payment: the prepare command, and the submit command with a placeholder', () => {
    const c = coreCommands(locked())!;
    expect(c.prepare).toMatch(/^gobject prepare 0 1 \d+ [0-9a-f]+$/);
    expect(c.submit).toMatch(/<collateral txid>$/);
  });

  it.each([
    ['not json', () => 'nope', /not JSON/],
    ['another file', () => JSON.stringify({ format: 'x' }), /not a govhub proposal backup/],
    ['a newer version', (t: string) => t.replace('"version": 1', '"version": 2'), /version 2/],
    ['the time changed', (t: string) => { const o = JSON.parse(t); o.draft.lock.time += 1; return JSON.stringify(o); }, /altered/],
    ['the data changed', (t: string) => { const o = JSON.parse(t); o.draft.lock.dataHex = o.draft.lock.dataHex.replace('3132', '3133'); return JSON.stringify(o); }, /altered|damaged/],
    ['a shown field changed', (t: string) => { const o = JSON.parse(t); o.draft.lock.paymentAddress = 'Xother'; return JSON.stringify(o); }, /altered/],
    ['the amount changed', (t: string) => { const o = JSON.parse(t); o.draft.lock.paymentDuffs = '1'; return JSON.stringify(o); }, /altered/],
    ['a bad txid', (t: string) => { const o = JSON.parse(t); o.draft.payment = { method: 'core', txid: 'xyz' }; return JSON.stringify(o); }, /txid/],
  ])('refuses %s', (_l, f, re) => {
    const text = backupFile(locked()).text;
    expect(() => readBackup((f as (t: string) => string)(text), 'mainnet')).toThrow(re as RegExp);
  });

  it('refuses the other network with a way out', () => {
    expect(() => readBackup(backupFile(locked('testnet')).text, 'mainnet')).toThrow(BackupError);
    expect(() => readBackup(backupFile(locked('testnet')).text, 'mainnet')).toThrow(/Switch the network profile/);
  });

  it('merge keeps the copy that is further along', () => {
    const d = locked();
    const paid = { ...d, payment: { method: 'core' as const, txid: 'ab'.repeat(32) } };
    expect(mergeDraft(null, d)).toBe(d);
    expect(mergeDraft(d, paid)).toBe(paid);
    expect(mergeDraft(paid, d)).toBe(paid);
    const other = { ...locked(), id: d.id };
    other.lock = { ...other.lock!, govHash: 'ee'.repeat(32) };
    expect(mergeDraft(d, other).id).not.toBe(d.id);
  });
});

describe('deposit index', () => {
  it('a random free index within the scan gap, then the next free one; never a used one', () => {
    const at = (i: number) => `addr${i}`;
    const d = (a: string) => ({ ...newDraft('mainnet'), payment: { method: 'browser' as const, funding: { address: a } as never } });
    expect(nextDepositIndex([], at, 20, () => 0)).toBe(0);
    expect(nextDepositIndex([], at, 20, () => 0.999)).toBe(19);
    expect(nextDepositIndex([d('addr0'), d('addr1'), d('addr3')], at, 4, () => 0)).toBe(2);
    expect(nextDepositIndex([d('addr0'), d('addr1'), d('addr2')], at, 3, () => 0.5)).toBe(3);
    for (let k = 0; k < 50; k++) expect(nextDepositIndex([d('addr5')], at)).not.toBe(5);
  });

  it('pay-now problems: expired, or a single payment past its voting deadline', () => {
    const l = locked().lock!;
    expect(payNowProblem(l, null, now, 1662)).toBeNull();
    expect(payNowProblem(l, 2_575_480 - 1662 - 100, now, 1662)).toBeNull();
    expect(payNowProblem(l, 2_575_480 - 1662, now, 1662)).toMatch(/voting deadline/);
    expect(payNowProblem({ ...l, superblocks: [2_575_480, 2_592_096] }, 2_575_480, now, 1662)).toBeNull();
    expect(payNowProblem(l, null, l.endEpoch, 1662)).toMatch(/end date/);
  });

  it('a backup made after the fee transaction was built says not to pay again and carries its txid', () => {
    const d = { ...locked(), payment: { method: 'browser' as const, funding: { address: 'yX', source: { kind: 'seed', index: 0 }, network: 'mainnet', govHashRaw: 'x', refundAddress: 'y', deposits: [], state: 'building', v: 1, tx: { txid: 'ef'.repeat(32) } } as never } };
    expect(backupMilestone(d)).toBe('signed');
    const o = JSON.parse(backupFile(d).text);
    expect(o.collateralTxid).toBe('ef'.repeat(32));
    expect(o.readme.join(' ')).toMatch(/DO NOT PAY AGAIN/);
    expect(o.commands.submit).toContain('ef'.repeat(32));
  });
});
