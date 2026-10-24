// Real mainnet proposals (public RPC, read-only; see scripts/fetch-mainnet-vectors.mjs). `gobject list` does not expose
// the object revision; every proposal here hashes correctly with revision 1.
import { describe, expect, it } from 'vitest';
import { checkCollateralTx, governanceObjectHash, hexToBytes, parseProposalData, validateProposalData } from '../src/index.ts';
import { fixture } from './helpers.ts';

const fx = fixture('mainnet-proposals.json');
const props = fx.proposals as Array<any>;

describe(`mainnet vectors (${props.length} proposals fetched at height ${fx.blockHeight})`, () => {
  it('fixture is non-trivial', () => {
    expect(props.length).toBeGreaterThanOrEqual(5);
  });
  for (const p of props) {
    describe(`${p.hash.slice(0, 12)} ${p.dataString.slice(10, 50)}`, () => {
      const h = governanceObjectHash({ parentHash: '0', revision: 1, time: p.creationTime, dataHex: p.dataHex });
      it('gov hash matches the hash printed by mainnet Core', () => {
        expect(h.display).toBe(p.hash);
      });
      it('collateral tx (fetched raw) passes checkCollateralTx with this hash', () => {
        const r = checkCollateralTx(hexToBytes(p.rawTx), h.raw, { expectedTxid: p.collateralHash });
        expect(r.failure).toBeUndefined();
        expect(r.valid).toBe(true);
        expect(r.tx!.vout[r.opReturnIndex!]!.value).toBeGreaterThanOrEqual(100_000_000n);
        expect(p.confirmations).toBeGreaterThanOrEqual(6);
      });
      it('collateral fails for a different hash', () => {
        const other = governanceObjectHash({ parentHash: '0', revision: 1, time: p.creationTime + 1, dataHex: p.dataHex });
        expect(checkCollateralTx(hexToBytes(p.rawTx), other.raw).valid).toBe(false);
      });
      it('data parses and validates for mainnet (expiry ignored, like validation of relayed objects)', () => {
        const parsed = parseProposalData(p.dataHex);
        expect(parsed.fields).not.toBeNull();
        const v = validateProposalData(p.dataHex, 'mainnet');
        expect(v.valid, v.errors.join('; ')).toBe(true);
      });
    });
  }
});
