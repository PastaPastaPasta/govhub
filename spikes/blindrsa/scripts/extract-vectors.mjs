// Extracts RFC 9474 Appendix A test vectors from the RFC text into JSON.
// usage: node scripts/extract-vectors.mjs <rfc9474.txt> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;
if (!src || !out) throw new Error('usage: extract-vectors.mjs <rfc9474.txt> <out.json>');

const lines = readFileSync(src, 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith('Appendix A.  Test Vectors'));
const sections = [];
let cur = null;
let field = null;
for (let i = start; i < lines.length; i++) {
  const line = lines[i];
  const h = line.match(/^A\.(\d+)\.\s+(RSABSSA-\S+)\s+Test Vector/);
  if (h) {
    cur = { name: h[2], fields: {} };
    sections.push(cur);
    field = null;
    continue;
  }
  if (!cur) continue;
  if (/^Appendix B\./.test(line) || /^Authors' Addresses/.test(line)) break;
  // Skip page furniture.
  if (/^Hendrickson|^RFC 9474|\[Page \d+\]|\f/.test(line)) continue;
  const f = line.match(/^ {3}(p|q|n|e|d|msg|msg_prefix|prepared_msg|salt|encoded_msg|inv|blinded_msg|blind_sig|sig) = ([0-9a-f]*)$/);
  if (f) {
    field = f[1];
    cur.fields[field] = f[2];
    continue;
  }
  const c = line.match(/^ {3}([0-9a-f]+)$/);
  if (c && field) cur.fields[field] += c[1];
  else if (line.trim() === '') field = null;
}
writeFileSync(out, JSON.stringify(sections, null, 2) + '\n');
for (const s of sections) console.log(s.name, Object.keys(s.fields).join(','), `n=${s.fields.n?.length / 2}B`);
