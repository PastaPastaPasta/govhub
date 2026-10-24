import { describe, expect, it } from 'vitest';
import { buildProposalDataHex, bytesToHex, checkUrl, decodeAddress, encodeAddress, hexToBytes, parseCoreJson, parseProposalData, utf8ToBytes, validateProposal, validateProposalData, type ProposalFields } from '../src/index.ts';
import { fixture } from './helpers.ts';

const checkFx = fixture('check.regtest.json');
const checks = checkFx.checks as Array<{ label: string; dataHex: string; coreValid: boolean; coreError: string | null }>;
const props = fixture('proposals.regtest.json').proposals as Array<any>;

describe('validateProposalData parity with `gobject check` (regtest, 52 cases)', () => {
  for (const c of checks) {
    it(`${c.coreValid ? 'valid  ' : 'invalid'} ${c.label}`, () => {
      // `gobject check` runs ValidateProposal with fCheckExpiration=true at the node's clock; the fixture's `now`
      // is the time the vectors were generated (all "valid" cases expire 3 years later).
      const r = validateProposalData(c.dataHex, 'regtest', { now: checkFx.now });
      expect(r.valid, `${c.label}: ours=${r.errors.join('; ')} core=${c.coreError}`).toBe(c.coreValid);
    });
  }
  it('covers the interesting categories', () => {
    expect(checks.filter((c) => c.coreValid).length).toBeGreaterThanOrEqual(12);
    expect(checks.filter((c) => !c.coreValid).length).toBeGreaterThanOrEqual(30);
  });
  it('every proposal Core actually prepared and accepted is valid for us, with expiry checks off like network validation', () => {
    for (const p of props) expect(validateProposalData(p.dataHex, 'regtest').valid, p.label).toBe(true);
  });
});

describe('Core JSON quirks (UniValue::read result ignored by ParseProposalJSON)', () => {
  const addr = checkFx.addrA as string;
  const mk = (s: string) => bytesToHex(utf8ToBytes(s));
  const body = `"name":"x","payment_address":"${addr}","payment_amount":1,"start_epoch":1,"end_epoch":9999999999,"url":"abcd"`;
  it('accepts trailing garbage and truncation like Core', () => {
    expect(validateProposalData(mk(`{"type":1,${body}} junk`), 'regtest').valid).toBe(true);
    expect(parseProposalData(mk(`{"type":1,${body}} junk`)).wellFormedJson).toBe(false);
    expect(validateProposalData(mk(`{"type":1,${body}`), 'regtest').valid).toBe(true);
  });
  it('first duplicate key wins (JSON.parse would pick the last)', () => {
    expect(validateProposalData(mk(`{"type":1,"type":2,${body}}`), 'regtest').valid).toBe(true);
    expect(validateProposalData(mk(`{"type":2,"type":1,${body}}`), 'regtest').valid).toBe(false);
  });
  it('rejects non-integer numbers for integer fields', () => {
    for (const bad of ['1.0', '1e0', '"1"', 'true', 'null']) {
      expect(validateProposalData(mk(`{"type":${bad},${body}}`), 'regtest').valid, bad).toBe(false);
    }
  });
  it('key without value (truncated right after the key) is a missing field', () => {
    expect(validateProposalData(mk(`{${body},"type"`), 'regtest').valid).toBe(false);
    const r = parseCoreJson(utf8ToBytes('{"a":1,"b"'));
    expect(r.wellFormed).toBe(false);
    expect(r.root).toEqual({ t: 'obj', keys: ['a', 'b'], values: [{ t: 'num', s: '1' }] });
  });
  it('handles strings: escapes, surrogate pairs, invalid escapes', () => {
    const ok = parseCoreJson(utf8ToBytes('{"u":"\\u00e9\\ud83d\\ude00\\n\\/"}'));
    expect(ok.wellFormed).toBe(true);
    const root = ok.root as any;
    expect(Buffer.from(root.values[0].s, 'latin1').toString('utf8')).toBe('é\u{1f600}\n/');
    expect(parseCoreJson(utf8ToBytes('{"u":"\\q"}')).wellFormed).toBe(false);
    expect(parseCoreJson(utf8ToBytes('{"u":"\\ud83d"}')).wellFormed).toBe(false);
    expect(parseCoreJson(utf8ToBytes('{"n":01}')).wellFormed).toBe(false);
    expect(parseCoreJson(utf8ToBytes('[1,]')).wellFormed).toBe(false);
  });
  it('size cap counts bytes', () => {
    const exactly512 = '{"pad":"' + 'p'.repeat(512 - 10) + '"}';
    expect(utf8ToBytes(exactly512).length).toBe(512);
    expect(validateProposalData(mk(exactly512), 'regtest').errors.join()).not.toContain('exceeds');
    expect(validateProposalData(mk(exactly512 + ' '), 'regtest').errors.join()).toContain('exceeds');
  });
});

describe('addresses', () => {
  const h20 = hexToBytes('00112233445566778899aabbccddeeff00112233');
  it('round-trips and enforces network prefixes (mainnet X/7, testnet y/8-9)', () => {
    const mainP2pkh = encodeAddress('p2pkh', h20, 'mainnet');
    const mainP2sh = encodeAddress('p2sh', h20, 'mainnet');
    const testP2pkh = encodeAddress('p2pkh', h20, 'testnet');
    const testP2sh = encodeAddress('p2sh', h20, 'testnet');
    expect(mainP2pkh[0]).toBe('X');
    expect(mainP2sh[0]).toBe('7');
    expect(testP2pkh[0]).toBe('y');
    expect(['8', '9']).toContain(testP2sh[0]);
    expect(decodeAddress(mainP2pkh, 'mainnet')?.type).toBe('p2pkh');
    expect(decodeAddress(mainP2sh, 'mainnet')?.type).toBe('p2sh');
    expect(decodeAddress(mainP2pkh, 'testnet')).toBeNull();
    expect(decodeAddress(testP2sh, 'mainnet')).toBeNull();
    expect(decodeAddress(testP2sh, 'regtest')?.type).toBe('p2sh');
    expect(decodeAddress(mainP2pkh.slice(0, -1) + (mainP2pkh.endsWith('a') ? 'b' : 'a'), 'mainnet')).toBeNull(); // checksum
    expect(decodeAddress('', 'mainnet')).toBeNull();
    // DIP-18 Platform bech32m address is not an L1 destination
    expect(decodeAddress('dash1kqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'mainnet')).toBeNull();
  });
});

describe('typed validateProposal + mainnet', () => {
  const h20 = hexToBytes('00112233445566778899aabbccddeeff00112233');
  const base = (over: Partial<ProposalFields> = {}): ProposalFields => ({
    type: 1,
    name: 'my-proposal_1',
    paymentAddress: encodeAddress('p2pkh', h20, 'mainnet'),
    paymentAmount: 12.5,
    startEpoch: 1_700_000_000,
    endEpoch: 1_800_000_000,
    url: 'https://gov.dashhq.org/p/x/my-proposal_1',
    ...over,
  });
  it('accepts valid mainnet fields incl. P2SH payout and uppercase names', () => {
    expect(validateProposal(base(), 'mainnet').valid).toBe(true);
    expect(validateProposal(base({ paymentAddress: encodeAddress('p2sh', h20, 'mainnet'), name: 'UPPER-case' }), 'mainnet').valid).toBe(true);
    expect(validateProposal(base(), 'testnet').valid).toBe(false); // wrong network
  });
  it('rejects each rule', () => {
    const bad: Array<[string, Partial<ProposalFields>]> = [
      ['type', { type: 2 }],
      ['name empty', { name: '' }],
      ['name 41', { name: 'a'.repeat(41) }],
      ['name bytes not chars', { name: 'é' }],
      ['name space', { name: 'a b' }],
      ['end<=start', { endEpoch: 1_700_000_000 }],
      ['amount 0', { paymentAmount: 0 }],
      ['amount NaN', { paymentAmount: NaN }],
      ['url short', { url: 'abc' }],
      ['url space', { url: 'http://a b' }],
      ['url bracket', { url: 'http://[::1/x' }],
      ['address junk', { paymentAddress: 'abc' }],
      ['float epoch', { startEpoch: 1.5 }],
    ];
    for (const [label, over] of bad) expect(validateProposal(base(over), 'mainnet').valid, label).toBe(false);
  });
  it('expiry only when now is supplied', () => {
    expect(validateProposal(base(), 'mainnet', { now: 1_900_000_000 }).errors).toContain('expired');
    expect(validateProposal(base(), 'mainnet', { now: 1_750_000_000 }).valid).toBe(true);
  });
  it('NBSP is not whitespace for Core (IsSpace is ASCII only) while ASCII \\v and \\f are', () => {
    expect(validateProposal(base({ url: 'http://a.b/ x' }), 'mainnet').valid).toBe(true);
    expect(validateProposal(base({ url: 'http://a.b/\vx' }), 'mainnet').valid).toBe(false);
    expect(validateProposal(base({ url: 'http://a.b/\fx' }), 'mainnet').valid).toBe(false);
  });
});

describe('checkUrl (Python urlparse bracket rule)', () => {
  it.each([
    ['http://[::1]:80/x', true],
    ['http://[::1/x', false],
    ['http://::1]/x', false],
    ['http://a.b/x[', true], // brackets outside the netloc are fine
    ['http://a.b/?q=]', true],
    ['//[a', false],
    ['abc[', true], // no "//" => no netloc
    ['x:[//[', true],
  ])('%s -> %s', (u, ok) => expect(checkUrl(u)).toBe(ok));
});

describe('buildProposalDataHex', () => {
  const f: ProposalFields = {
    type: 1,
    name: 'abc',
    paymentAddress: checkFx.addrA,
    paymentAmount: 100.5,
    startEpoch: 1000,
    endEpoch: 2000,
    url: 'https://example.org/é',
  };
  it('is deterministic, alphabetical, compact, and round-trips through parseProposalData', () => {
    const hex = buildProposalDataHex(f);
    expect(hex).toBe(buildProposalDataHex({ ...f }));
    const text = Buffer.from(hex, 'hex').toString('utf8');
    expect(text).toBe(`{"end_epoch":2000,"name":"abc","payment_address":"${checkFx.addrA}","payment_amount":100.5,"start_epoch":1000,"type":1,"url":"https://example.org/é"}`);
    const parsed = parseProposalData(hex);
    expect(parsed.wellFormedJson).toBe(true);
    expect(parsed.fields).toEqual(f);
    expect(validateProposalData(hex, 'regtest').valid).toBe(true);
  });
  it('refuses oversized or unrepresentable input', () => {
    expect(() => buildProposalDataHex({ ...f, url: 'https://x.org/' + 'a'.repeat(600) })).toThrow(/max 512/);
    expect(() => buildProposalDataHex({ ...f, paymentAmount: Infinity })).toThrow();
    expect(() => buildProposalDataHex({ ...f, startEpoch: 1.5 })).toThrow();
  });
});

describe('review hardening', () => {
  const addr = checkFx.addrA as string;
  const f: ProposalFields = { type: 1, name: 'abc', paymentAddress: addr, paymentAmount: 1, startEpoch: 1, endEpoch: 2, url: 'https://x.org/' };
  it('typed validator rejects strings that cannot be valid UTF-8 (lone surrogates)', () => {
    expect(validateProposal({ ...f, url: 'https://x/\ud800' }, 'regtest').valid).toBe(false);
    expect(validateProposal({ ...f, url: 'https://x/\udc00a' }, 'regtest').valid).toBe(false);
    expect(validateProposal({ ...f, url: 'https://x/😀' }, 'regtest').valid).toBe(true);
  });
  it('epochs beyond the JS safe range: validateProposalData still follows Core, typed fields are withheld', () => {
    const big = '9007199254740993';
    const hex = bytesToHex(utf8ToBytes(`{"end_epoch":${big},"name":"x","payment_address":"${addr}","payment_amount":1,"start_epoch":1,"type":1,"url":"abcd"}`));
    expect(validateProposalData(hex, 'regtest').valid).toBe(true);
    const p = parseProposalData(hex);
    expect(p.fields).toBeNull();
    expect(p.errors.join()).toContain('safe integer');
  });
});
