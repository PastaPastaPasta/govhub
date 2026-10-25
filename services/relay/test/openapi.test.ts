// openapi.json must describe what the code does: every route, every error code, every config variable in the README.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_ERROR } from '../src/proposer.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const spec = JSON.parse(read('../openapi.json'));

describe('openapi.json', () => {
  it('lists exactly the served routes and methods', () => {
    const served = ['GET /v1/status', 'POST /v1/votes', 'POST /v1/votes/cancel', 'GET /v1/votes/{id}', 'POST /v1/proposals/submit', 'POST /v1/proposals', 'GET /v1/proposals/{id}'];
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
    expect(documented.sort()).toEqual(served.sort());
    expect(spec.openapi).toBe('3.1.0');
  });

  it('enumerates every error code the source can emit', () => {
    const src = ['../src/relay.ts', '../src/api/server.ts'].map(read).join('\n');
    const used = new Set<string>();
    for (const m of src.matchAll(/new RelayError\(\d+, '([a-z-]+)'/g)) used.add(m[1]!);
    for (const m of src.matchAll(/badRequest\(/g)) used.add('bad-request');
    for (const m of src.matchAll(/code: '([a-z-]+)'/g)) used.add(m[1]!);
    used.add('core-unavailable');
    const documented = new Set<string>(spec.components.schemas.Error.properties.code.enum);
    expect([...used].filter((c) => !documented.has(c))).toEqual([]);
    expect([...documented].filter((c) => !used.has(c))).toEqual([]);
  });

  it('documents every response status the handlers use', () => {
    const post = spec.paths['/v1/votes'].post.responses;
    expect(Object.keys(post).sort()).toEqual(['200', '202', '400', '404', '409', '413', '429', '503']);
    expect(Object.keys(spec.paths['/v1/proposals/submit'].post.responses)).toContain('425');
    expect(Object.keys(spec.paths['/v1/proposals/submit'].post.responses)).toContain('501');
    expect(Object.keys(spec.paths['/v1/proposals'].post.responses).sort()).toEqual(['200', '202', '400', '404', '409', '413', '429', '501', '503']);
    expect(Object.keys(spec.paths['/v1/proposals/{id}'].get.responses).sort()).toEqual(['200', '400', '404', '501']);
  });

  it('lists exactly the held-proposal lastError codes and the status fields', () => {
    const view = spec.components.schemas.ProposalStatusView;
    expect(view.properties.lastError.enum.filter((c: unknown) => c !== null).sort()).toEqual(Object.values(PROPOSAL_ERROR).sort());
    expect(Object.keys(view.properties).sort()).toEqual([...view.required, 'coreMessage'].sort());
    expect(spec.components.schemas.Status.required).toEqual(expect.arrayContaining(['proposalHold']));
  });
});

describe('README.md', () => {
  it('documents every configuration variable', () => {
    const cfg = read('../src/config.ts');
    const vars = new Set([...cfg.matchAll(/(?:str|int|bool)\(env, '([A-Z_]+)'/g)].map((m) => m[1]!));
    for (const extra of ['CORE_RPC_PASSWORD', 'CORE_RPC_PASSWORD_FILE', 'RELAY_LOG_LEVEL']) vars.add(extra);
    expect(vars.size).toBeGreaterThanOrEqual(20);
    const readme = read('../README.md');
    expect([...vars].filter((v) => !readme.includes('`' + v + '`'))).toEqual([]);
  });
});
