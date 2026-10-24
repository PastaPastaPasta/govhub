// Read-only evo-sdk 5.x exercise against a live network.
//
//   npm run mainnet-read     (PV13 today)
//   npm run testnet-read     (PV14)
//
// Records connect/first-query timing, sdk.version() before/after the first proven query, DPNS
// contract + domain documents + identity-by-name (all via the *WithProof variants and the
// response metadata), and one DPNS contested-resource vote poll (EvoVote parity). Nothing is
// signed or broadcast.
import { DPNS_CONTRACT_ID, DPNS_POLL, decodeIndexValue, errText, plain, saveResult, timed } from './lib.ts';

const network = process.argv[2];
if (network !== 'mainnet' && network !== 'testnet') {
  console.error('usage: read-network.ts <mainnet|testnet>');
  process.exit(1);
}

const out: Record<string, any> = { network, sdk: '@dashevo/evo-sdk@5.0.0-rc.8', at: new Date().toISOString(), steps: {}, problems: [] };
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const { value, ms } = await timed(fn);
    out.steps[name] = { ok: true, ms, ...(value && typeof value === 'object' ? { result: plain(value) } : { result: value }) };
    console.log(`ok   ${name} (${ms} ms)`);
    return value;
  } catch (e) {
    out.steps[name] = { ok: false, error: errText(e) };
    out.problems.push(`${name}: ${errText(e)}`);
    console.log(`FAIL ${name}: ${errText(e)}`);
    return undefined;
  }
};
const meta = (r: any) => (r?.metadata ? { height: String(r.metadata.height), protocolVersion: r.metadata.protocolVersion, epoch: r.metadata.epoch, coreChainLockedHeight: r.metadata.coreChainLockedHeight, timeMs: String(r.metadata.timeMs) } : undefined);
const proofInfo = (r: any) => (r?.proof ? { grovedbProofBytes: r.proof.grovedbProof?.length, quorumHash: Buffer.from(r.proof.quorumHash).toString('hex').slice(0, 16) + '…', signatureBytes: r.proof.signature?.length, quorumType: r.proof.quorumType } : undefined);

// 1. module load + wasm init
const tLoad = performance.now();
const mod = await import('evo5');
out.timings = { importMs: Math.round(performance.now() - tLoad) };
const tInit = performance.now();
await mod.ensureInitialized();
out.timings.wasmInitMs = Math.round(performance.now() - tInit);
out.latestSupportedVersion = await mod.EvoSDK.getLatestVersionNumber();

// 2. connect
const sdk = network === 'mainnet' ? mod.EvoSDK.mainnetTrusted() : mod.EvoSDK.testnetTrusted();
try { out.versionBeforeConnect = sdk.version(); } catch (e) { out.versionBeforeConnect = `throws: ${errText(e)}`; }
const tc = await timed(() => sdk.connect());
out.timings.connectMs = tc.ms;
out.versionAfterConnect = sdk.version();
console.log(`connect ${tc.ms} ms; sdk.version() before connect ${out.versionBeforeConnect}, after connect ${out.versionAfterConnect}`);

// 3. first proven query = DPNS contract; record version afterwards
const first = await timed(() => sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID));
out.timings.firstProvenQueryMs = first.ms;
out.versionAfterFirstQuery = sdk.version();
out.steps.dpnsContract = { ok: true, ms: first.ms, metadata: meta(first.value), proof: proofInfo(first.value) };
console.log(`first proven query ${first.ms} ms; sdk.version() after = ${out.versionAfterFirstQuery}; chain protocolVersion ${first.value.metadata?.protocolVersion}`);
const dpns: any = first.value.data;
out.steps.dpnsContract.documentTypes = Object.keys(dpns.schemas ?? {});
out.steps.dpnsContract.domainIndices = (dpns.schemas?.domain?.indices ?? []).map((i: any) => ({ name: i.name, unique: i.unique, contested: !!i.contested, properties: i.properties }));
const warm = await timed(() => sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID));
out.timings.warmProvenQueryMs = warm.ms;

await step('system.status', async () => {
  const s: any = await sdk.system.status();
  const j = s?.toJSON ? s.toJSON() : s;
  return { version: j?.version ?? j, chain: j?.chain ?? undefined };
});

// 4. domain documents with proof
const docs = await step('dpns.domainsQuery', async () => {
  const r: any = await sdk.documents.queryWithProof({
    dataContractId: DPNS_CONTRACT_ID, documentTypeName: 'domain',
    where: [['normalizedParentDomainName', '==', 'dash'], ['normalizedLabel', 'startsWith', 'a']],
    orderBy: [['normalizedLabel', 'asc']], limit: 5,
  });
  const list = [...r.data.values()].filter(Boolean).map((d: any) => {
    const j = d.toJSON(); return { id: j.$id ?? String(d.id), ownerId: j.$ownerId ?? String(d.ownerId), label: j.label, normalizedLabel: j.normalizedLabel, parent: j.normalizedParentDomainName };
  });
  return { count: list.length, metadata: meta(r), proof: proofInfo(r), docs: list };
});
const sample = (docs as any)?.docs?.[0];

// 5. identity by DPNS name
if (sample) {
  const name = `${sample.label}.dash`;
  const info = await step('dpns.getUsernameByName', async () => {
    const r: any = await sdk.dpns.getUsernameByNameWithProof(name);
    return { name, info: plain(r.data), metadata: meta(r), proof: proofInfo(r) };
  });
  const id = (info as any)?.info?.identityId ?? (info as any)?.info?.ownerId ?? sample.ownerId;
  await step('identities.fetchWithProof', async () => {
    const r: any = await sdk.identities.fetchWithProof(id);
    const ident = r.data;
    return { id, found: !!ident, balance: ident ? String(ident.balance) : undefined, keyCount: ident ? ident.publicKeys.length : undefined, metadata: meta(r), proof: proofInfo(r) };
  });
  await step('dpns.resolveName', async () => ({ name, identityId: await sdk.dpns.resolveName(name) }));
  const rev = await step('dpns.reverse(username)', async () => ({ identityId: id, username: await sdk.dpns.username(id) }));
  // getUsernameByName returned nothing for the homograph-converted sample label above; retry with a plain name.
  const plainName = (rev as any)?.username as string | undefined;
  if (plainName) {
    await step('dpns.getUsernameByName(plain)', async () => {
      const r: any = await sdk.dpns.getUsernameByNameWithProof(plainName);
      return { name: plainName, info: plain(r.data), metadata: meta(r) };
    });
    // FINDING: getUsernameByName matches normalizedLabel but does not homograph-convert its input
    // (o->0, i/l->1), so names containing o/i/l miss unless converted first. resolveName converts.
    await step('dpns.getUsernameByName(homographSafe)', async () => {
      const [label, parent] = plainName.split('.');
      const safe = `${await sdk.dpns.convertToHomographSafe(label)}.${parent}`;
      const r: any = await sdk.dpns.getUsernameByNameWithProof(safe);
      return { name: safe, info: plain(r.data), metadata: meta(r) };
    });
  }
}

// 6. contested vote polls
const polls = await step('voting.votePollsByEndDate(active)', async () => {
  const r: any = await sdk.voting.votePollsByEndDateWithProof({ startTimeMs: Date.now(), startTimeIncluded: true, orderAscending: true, limit: 20 });
  const buckets = r.data as any[];
  const flat: { label?: string; endsAtMs: string; type: string }[] = [];
  for (const b of buckets) for (const p of Array.from(b.votePolls ?? [])) {
    const poll: any = p;
    flat.push({ type: poll.documentTypeName, endsAtMs: String(b.timestampMs), label: decodeIndexValue(Array.from(poll.indexValues ?? [])[1]) });
  }
  return { buckets: buckets.length, polls: flat.length, first: flat.slice(0, 5), metadata: meta(r), proof: proofInfo(r) };
});
let label: string | undefined = (polls as any)?.first?.find((p: any) => p.type === 'domain' && p.label)?.label;
let activeContest = !!label;
if (!label) {
  out.notes = [...(out.notes ?? []), 'no active (future-ending) DPNS contests; falling back to the most recent ended poll / archive'];
  const past = await step('voting.votePollsByEndDate(recent)', async () => {
    const r: any = await sdk.voting.votePollsByEndDateWithProof({ orderAscending: false, limit: 10 });
    const flat: any[] = [];
    for (const b of r.data as any[]) for (const p of Array.from(b.votePolls ?? []) as any[]) flat.push({ type: p.documentTypeName, endsAtMs: String(b.timestampMs), label: decodeIndexValue(Array.from(p.indexValues ?? [])[1]) });
    return { polls: flat.length, first: flat.slice(0, 5), metadata: meta(r) };
  });
  label = (past as any)?.first?.find((p: any) => p.type === 'domain' && p.label)?.label;
}
await step('group.contestedResources(dash)', async () => {
  const r: any = await sdk.group.contestedResourcesWithProof({ ...DPNS_POLL, startIndexValues: ['dash'], limit: 5 });
  if (!label) label = (r.data as any[]).map((x) => (Array.isArray(x) ? x[x.length - 1] : x)).find((x) => typeof x === 'string');
  return { sample: plain(r.data), metadata: meta(r), proof: proofInfo(r) };
});
if (label) {
  out.contestLabel = label; out.contestActive = activeContest;
  await step('voting.contestedResourceVoteState', async () => {
    const r: any = await sdk.voting.contestedResourceVoteStateWithProof({ ...DPNS_POLL, indexValues: ['dash', label], resultType: 'documentsAndVoteTally', includeLockedAndAbstaining: true, limit: 100 });
    const s: any = r.data;
    const contenders = Array.from(s.contenders ?? []).map((c: any) => ({ identityId: c.identityId.toBase58(), voteTally: c.voteTally, hasDoc: !!c.serializedDocument }));
    return { label, active: activeContest, contenders, abstain: s.abstainVoteTally, lock: s.lockVoteTally, winner: s.winner ? { kind: s.winner.kind, identityId: s.winner.identityId?.toBase58?.(), blockTimeMs: s.winner.block ? String(s.winner.block.timeMs) : undefined } : null, metadata: meta(r), proof: proofInfo(r) };
  });
  // voters for the leading contender (ProTxHashes)
  const st: any = out.steps['voting.contestedResourceVoteState']?.result;
  const lead = st?.contenders?.[0]?.identityId;
  if (lead) await step('group.contestedResourceVotersForIdentity', async () => {
    const r: any = await sdk.group.contestedResourceVotersForIdentityWithProof({ ...DPNS_POLL, indexValues: ['dash', label], contestantId: lead, limit: 5 });
    return { votersReturned: (r.data as any[]).length, first: (r.data as any[]).slice(0, 2).map((x) => x.toHex?.() ?? String(x)), metadata: meta(r) };
  });
}

// 7. a few PV13-compat probes for later phases
await step('documentCreateCost-capable (Document.fromBytes ver)', async () => ({ sdkVersion: sdk.version(), fnPresent: typeof (mod as any).documentCreateCost === 'function' || typeof (sdk as any).wasm?.documentCreateCost === 'function' }));

out.versionFinal = sdk.version();
const path = saveResult(`${network}-read.json`, out);
console.log(`\nversion: before connect ${out.versionBeforeConnect}, after connect ${out.versionAfterConnect}, after first query ${out.versionAfterFirstQuery}, final ${out.versionFinal}`);
console.log(`timings: ${JSON.stringify(out.timings)}`);
console.log(`problems: ${out.problems.length ? '\n  ' + out.problems.join('\n  ') : 'none'}`);
console.log(`saved ${path}`);
process.exit(0);
