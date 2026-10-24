import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')) as T;
}
