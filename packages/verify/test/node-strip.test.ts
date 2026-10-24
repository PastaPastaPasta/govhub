// The package is consumed as plain .ts by Node (audit CLI) without a build step: make sure only erasable TypeScript syntax is used.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('runs under plain Node type stripping', () => {
  it('imports the whole package and hashes with it', () => {
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as v from ${JSON.stringify(entry)}; console.log(v.governanceObjectHash({parentHash:'0',revision:1,time:0,dataHex:'7b7d'}).display)`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(out.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});
