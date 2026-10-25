// Defects D-034, D-035, D-038, D-040, D-075, D-077 (govhub QA, fix group F4): bidi and invisible characters, misleading
// link text, badge-like display names, entities, the inflate cap at write time and newest-first comment reads.
import { describe, expect, it } from 'vitest';
import {
  badgeLike,
  cleanName,
  forumOps,
  ForumReader,
  isBlank,
  linkRealHost,
  MemoryStore,
  nameProblem,
  packPostBody,
  parseMarkdown,
  parsePlain,
  POST_MAX_INFLATED,
  PostTooLongError,
  unpackPostBody,
  type ForumContracts,
  type MdBlock,
  type MdInline,
} from '../src/index.ts';

const RLO = '\u202E';
const BIDI = ['\u202A', '\u202B', '\u202C', '\u202D', RLO, '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C'];
const ZW = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD'];

function strings(bs: MdBlock[]): string[] {
  const out: string[] = [];
  const il = (xs: MdInline[]) => {
    for (const x of xs) {
      if (x.t === 'text' || x.t === 'code') out.push(x.v);
      else if (x.t === 'image') out.push(x.alt);
      else if ('c' in x) il(x.c);
    }
  };
  const bl = (ys: MdBlock[]) => {
    for (const y of ys) {
      if (y.t === 'p' || y.t === 'h') il(y.c);
      else if (y.t === 'code') out.push(y.v);
      else if (y.t === 'quote') bl(y.c);
      else if (y.t === 'list') y.items.forEach(bl);
      else if (y.t === 'table') [y.head, ...y.rows].forEach((r) => r.forEach(il));
    }
  };
  bl(bs);
  return out;
}
const linkNodes = (bs: MdBlock[]): Array<Extract<MdInline, { t: 'link' }>> => {
  const out: Array<Extract<MdInline, { t: 'link' }>> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if ((x as { t?: string }).t === 'link') out.push(x as Extract<MdInline, { t: 'link' }>);
      Object.values(x).forEach(walk);
    }
  };
  walk(bs);
  return out;
};
const hasBidi = (s: string) => BIDI.some((c) => s.includes(c));

describe('D-034: bidi controls never reach rendered text', () => {
  it('typed controls are removed from text, code spans, code blocks, link text, image alt and plain comments', () => {
    for (const c of BIDI) {
      const md = `invoice${c}txt.exe \`a${c}b\` [x${c}y](https://dash.org) ![al${c}t](https://dash.org/i.png)\n\n\`\`\`\nco${c}de\n\`\`\`\n\n> q${c}`;
      const all = strings(parseMarkdown(md)).join('|');
      expect(hasBidi(all), JSON.stringify(c)).toBe(false);
      expect(all).toContain('invoicetxt.exe');
      expect(strings(parsePlain(`plain${c}text`)).join('')).toBe('plaintext');
    }
  });

  it('character references that decode to a control are dropped too', () => {
    const all = strings(parseMarkdown('invoice&#x202E;txt.exe &#8238; &#X202e; &rlm; &lrm; &#x2066;x')).join('');
    expect(hasBidi(all)).toBe(false);
    expect(all).toContain('invoicetxt.exe');
  });
});

describe('D-034: link text that names another host shows the real one', () => {
  const one = (md: string) => linkNodes(parseMarkdown(md))[0]!;
  it('a URL or domain as link text pointing elsewhere carries the target host', () => {
    expect(one('[https://dash.org](https://evil.example/x)').realHost).toBe('evil.example');
    expect(one('[dash.org](https://evil.example)').realHost).toBe('evil.example');
    expect(one('[**dash.org/download**](http://evil.example)').realHost).toBe('evil.example');
    expect(one('[gov.dashhq.org](https://gov.dashhq.org.evil.example/p)').realHost).toBe('gov.dashhq.org.evil.example');
    // bidi controls cannot hide the domain from the check
    expect(one(`[dash.org${RLO}](https://evil.example)`).realHost).toBe('evil.example');
    // a look-alike (Cyrillic a) is another host; an internationalised target always shows its punycode
    expect(one('[d\u0430sh.org](https://dash.org)').realHost).toBe('dash.org');
    expect(one('[d\u0430sh.org](https://d\u0430sh.org/)').realHost).toMatch(/^xn--/);
    // a domain anywhere in the text, or wrapped in punctuation, counts
    expect(one('[Visit dash.org today](https://evil.example)').realHost).toBe('evil.example');
    expect(one('[https://dash.org)](https://evil.example)').realHost).toBe('evil.example');
    expect(one('[(dash.org)](https://evil.example)').realHost).toBe('evil.example');
  });

  it('honest links stay as they are', () => {
    expect(one('[dash.org](https://dash.org/about)').realHost).toBeUndefined();
    expect(one('[www.dash.org](https://dash.org)').realHost).toBeUndefined();
    expect(one('[DASH.org](https://www.dash.org/x)').realHost).toBeUndefined();
    expect(one('[read the budget notes](https://evil.example)').realHost).toBeUndefined();
    expect(one('see https://dash.org/x here').realHost).toBeUndefined(); // autolink
    expect(linkRealHost('dash.org', null)).toBeNull();
  });
});

describe('D-077: common named character references decode', () => {
  it('&hellip; &copy; &mdash; &euro; &rarr; and friends show as characters; unknown names stay as typed', () => {
    const all = strings(parseMarkdown('a&hellip; &copy; 2026 &mdash; 5&euro; &rarr; &trade; &frac12; &eacute; &Eacute; &AMP; &bogus;')).join('');
    expect(all).toBe('a\u2026 \u00A9 2026 \u2014 5\u20AC \u2192 \u2122 \u00BD \u00E9 \u00C9 & &bogus;');
    expect(strings(parseMarkdown('&constructor; &toString; &valueOf; &hasOwnProperty;')).join('')).toBe('&constructor; &toString; &valueOf; &hasOwnProperty;');
  });
});

describe('D-075: bodies with nothing visible are empty', () => {
  const ops = forumOps({ forum: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw', mod: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', gov: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ' });
  const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
  it('zero-width, bidi, filler and space characters alone are blank, and the comment builder refuses them', () => {
    for (const body of [ZW.join(''), BIDI.join(' '), '\u00A0\u3000\n', '\u2800\u3164\u115F', '\uFE0F', `${RLO}\u200D`]) {
      expect(isBlank(body), JSON.stringify(body)).toBe(true);
      expect(() => ops.comment(H, body)).toThrow(/empty/);
    }
    for (const body of ['a', '\u{1F600}', `x${RLO}`, '.']) expect(isBlank(body)).toBe(false);
  });
});

describe('D-035: display names', () => {
  const ops = forumOps({ forum: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw', mod: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', gov: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ' });
  it('rendering removes every invisible character, so a spoof shows what it really is', () => {
    expect(cleanName(`${RLO}ecila`)).toBe('ecila');
    expect(cleanName('al\u200Bice')).toBe('alice');
    for (const c of [...BIDI, ...ZW]) expect(cleanName(`bo${c}b`)).toBe('bob');
    expect(cleanName('  a \t b  ')).toBe('a b');
  });

  it('the profile builder refuses invisible characters and badge text', () => {
    for (const name of [`${RLO}ecila`, 'al\u200Bice', 'bob\u200D', 'bob \u2713 proposal owner', 'Proposal Owner', 'verified bob', 'bob\u2714', 'bob \u2705', '\uFF4F\uFF57\uFF4E\uFF45\uFF52', 'govhub moderation']) {
      expect(nameProblem(name), name).not.toBeNull();
      expect(() => ops.profile({ displayName: name })).toThrow();
    }
    for (const name of ['Alice', 'bob.mn', 'Dash Growth team', 'Ownerless Ltd', '\u5F20\u4F1F', 'Zo\u00EB']) {
      expect(nameProblem(name), name).toBeNull();
      expect(() => ops.profile({ displayName: name })).not.toThrow();
    }
    expect(badgeLike('bob \u2713')).toBe(true);
  });

  it('look-alike letters and digits, separators, a ".dash" ending and mixed scripts do not get around it; emoji names do', () => {
    for (const name of ['Verifi\u0435d', 'bob_owner', '0wner', 'Adm1n', 'alice.dash', 'ALICE.DASH', 'p\u0430ypal', 'bob \u221A', 'o\u0332wner', 'v\u00E9rified']) {
      expect(nameProblem(name), name).not.toBeNull();
      expect(badgeLike(name), name).toBe(true);
    }
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(nameProblem(family)).toBeNull();
    expect(cleanName(family)).toBe(family);
    const coder = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'; // a skin tone before the joiner
    expect(nameProblem(coder)).toBeNull();
    expect(cleanName(coder)).toBe(coder);
    expect(cleanName('a\u200Db')).toBe('ab');
    expect(nameProblem('\u0421\u0435\u0440\u0433\u0435\u0439')).toBeNull(); // all Cyrillic is fine
  });
});

describe('D-040: post bodies readers would refuse are refused when written', () => {
  it('a compressible body over 256 KiB fits in 3 chunks but is refused; the cap itself round-trips', async () => {
    const err = await packPostBody('a'.repeat(300_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostTooLongError);
    expect((err as PostTooLongError).bytes).toBe(300_000);
    await expect(packPostBody('a'.repeat(POST_MAX_INFLATED + 1))).rejects.toBeInstanceOf(PostTooLongError);
    const atCap = 'a'.repeat(POST_MAX_INFLATED);
    expect(await unpackPostBody(await packPostBody(atCap))).toBe(atCap);
  });
});

describe('D-038: comments are read newest first', () => {
  it('a flood past the page cap pushes out the oldest, never the newest; truncated is reported; order stays oldest first', async () => {
    const C: ForumContracts = { forum: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw', mod: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', gov: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ' };
    const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
    let t = 1_792_800_000_000;
    const now = () => (t += 1000);
    const store = new MemoryStore({ contracts: C, owners: { mod: C.forum, gov: C.forum }, now });
    const ops = forumOps(C, now);
    const spammer = '4TEp8FeD7iMD9nKMGBK492ZnbESdwFPPXtvjRA6Zrxhv';
    for (let i = 0; i < 250; i++) store.apply(spammer, ops.comment(H, `spam ${i}`));
    store.apply('4eYvJ1QzRxFy82CRK3tP5QHmdRcgkG8xdbGBQMqSroif', ops.comment(H, 'the newest real comment'));
    const r = await new ForumReader(store).comments(H, 2);
    expect(r.truncated).toBe(true);
    expect(r.comments).toHaveLength(200);
    expect(r.comments.at(-1)!.body).toBe('the newest real comment');
    expect(r.comments[0]!.body).toBe('spam 51');
    expect(r.comments.every((c, i) => i === 0 || c.createdAt >= r.comments[i - 1]!.createdAt)).toBe(true);
    const all = await new ForumReader(store).comments(H);
    expect(all.truncated).toBe(false);
    expect(all.comments).toHaveLength(251);
    expect(all.comments[0]!.body).toBe('spam 0');
  });
});

describe('D-018: accepting a URL naming', () => {
  it('acceptNamedOwnership writes a method-1 claim that reads back', async () => {
    const C: ForumContracts = { forum: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw', mod: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', gov: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ' };
    const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
    const store = new MemoryStore({ contracts: C, owners: { mod: C.forum, gov: C.forum } });
    const id = '4eYvJ1QzRxFy82CRK3tP5QHmdRcgkG8xdbGBQMqSroif';
    store.apply(id, forumOps(C).acceptNamedOwnership(H));
    const [c] = await new ForumReader(store).claims(H);
    expect(c).toMatchObject({ ownerId: id, method: 1 });
    expect(c!.sig).toHaveLength(65);
  });
});
