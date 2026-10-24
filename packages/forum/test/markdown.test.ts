import { describe, expect, it } from 'vitest';
import { parseMarkdown, parsePlain, safeHref, type MdBlock, type MdInline } from '../src/index.ts';

/** Every string that ends up in the tree, flattened, to assert nothing becomes markup. */
function texts(bs: MdBlock[]): string[] {
  const out: string[] = [];
  const il = (xs: MdInline[]) => {
    for (const x of xs) {
      if (x.t === 'text' || x.t === 'code') out.push(x.v);
      else if (x.t === 'link') il(x.c);
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
const links = (bs: MdBlock[]): Array<string | null> => JSON.stringify(bs).match(/"href":(null|"[^"]*")/g)!.map((m) => JSON.parse(m.slice(7)));

describe('safe markdown', () => {
  it('only absolute http(s) links survive', () => {
    expect(safeHref('https://dash.org/x?y=1')).toBe('https://dash.org/x?y=1');
    expect(safeHref('http://dash.org')).toBe('http://dash.org/');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.org/x', '/relative', '#frag', 'mailto:a@b.c', 'file:///etc/passwd', '', null]) {
      expect(safeHref(bad as string)).toBeNull();
    }
  });

  it('raw HTML is literal text, never markup', () => {
    const md = '<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> <b>bold</b>\n\n<div onclick="x">block</div>';
    const tree = parseMarkdown(md);
    const all = texts(tree).join('');
    expect(all).toContain('<script>');
    expect(all).toContain('<img src=x onerror=alert(1)>');
    expect(all).toContain('<div onclick="x">block</div>');
    // the tree only has the safe node types
    expect(JSON.stringify(tree)).not.toMatch(/"t":"(html|raw)"/);
  });

  it('dangerous link and image targets lose their href but keep their text', () => {
    const tree = parseMarkdown('[a](javascript:alert(1)) [b](https://ok.org) ![c](https://img.host/x.png) ![d](data:image/png;base64,AAAA) <javascript:alert(2)>');
    expect(links(tree)).toEqual([null, 'https://ok.org/', 'https://img.host/x.png', null, null]);
    expect(texts(tree).join('')).toContain('a');
    const img = JSON.stringify(tree).match(/"t":"image"/g);
    expect(img).toHaveLength(2);
  });

  it('autolinks, emphasis, code, lists, quotes, tables and headings', () => {
    const tree = parseMarkdown('# T\n\n**b** _i_ ~~d~~ `c<d>` https://dash.org\n\n- one\n- two\n\n3. x\n4. y\n\n> q\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n```js\nlet x = "<b>";\n```');
    const kinds = tree.map((b) => b.t);
    expect(kinds).toEqual(['h', 'p', 'list', 'list', 'quote', 'table', 'code']);
    expect(tree[3]).toMatchObject({ t: 'list', ordered: true, start: 3 });
    expect(tree[6]).toEqual({ t: 'code', lang: 'js', v: 'let x = "<b>";' });
    expect(links(tree)).toEqual(['https://dash.org/']);
    expect(texts(tree)).toContain('c<d>');
  });

  it('single newlines are line breaks; entities show as the characters they name', () => {
    const [p] = parseMarkdown('a\nb &amp; &lt;x&gt; &#65; &#x1F600; &bogus;');
    expect(p).toMatchObject({ t: 'p' });
    const c = (p as { c: MdInline[] }).c;
    expect(c.some((x) => x.t === 'br')).toBe(true);
    expect(texts([p!]).join('')).toContain('b & <x> A 😀 &bogus;');
  });

  it('caps nesting depth so pathological input cannot recurse without bound', () => {
    const deep = parseMarkdown('>'.repeat(2000) + ' x');
    let d = 0;
    let cur: MdBlock | undefined = deep[0];
    while (cur?.t === 'quote') {
      d++;
      cur = cur.c[0];
    }
    expect(d).toBeLessThanOrEqual(8);
    expect(() => parseMarkdown('*'.repeat(5000) + 'x' + '*'.repeat(5000))).not.toThrow();
    expect(() => parseMarkdown('[' .repeat(3000) + 'x' + '](https://a.b)'.repeat(3000))).not.toThrow();
  });

  it('plain comments keep every character literally', () => {
    const tree = parsePlain('**not bold** <b>\nline 2\n\n\npara 2');
    expect(tree).toHaveLength(2);
    expect(texts(tree)).toEqual(['**not bold** <b>', 'line 2', 'para 2']);
  });
});
