// What an owner's page says: DashCentral's description, Google Docs and ordinary pages, and owners.json as the browser re-checks it.
import { describe, expect, it } from 'vitest';
import { parseOwnerPage, parseOwnerPages, sameAsName } from './ownerPages.ts';

const HASH = '91808ffd72336fd89bcf5f0b3377b3c73a9b5873da8ac9419b59ba8c92e56640';
const OTHER = '0'.repeat(64);
const DC = 'https://www.dashcentral.org/p/DCG-Operations-Aug-Nov-26';

const dashcentral = (description: string, hash = HASH) => `<!DOCTYPE html><html><head><title>Proposal "X" - DashCentral.org</title>
<meta name="description" content="Dash Core Group Operations September - December 2026" /></head><body>
<table><tbody>
<tr><td>Title:</td><td>Dash Core Group Operations September - December 2026</td></tr>
<tr><td>Owner:</td><td>quantumexplorer</td></tr></tbody></table>
<tr><td colspan="2"><strong>Manually vote on this proposal:</strong><br>
gobject vote-many ${hash} funding yes<br></td></tr>
<div id="description" style="overflow:hidden; display:block;">${description}</div><br>
<div id="show_full_description" class="btn">Show full description ...</div>
<div class="widget">Discussion: this text is long enough to be a paragraph but is not part of the owner's description at all.</div>
</body></html>`;

describe('a title that names nothing in particular', () => {
  it('is dropped, keeping the opening words', () => {
    const html = '<html><head><meta property="og:title" content="Dash proposal"><meta property="og:description" content="Turning the Dash DAO into a visible founder, application and adoption engine for Platform apps."></head></html>';
    const page = parseOwnerPage(html, { url: 'https://docs.google.com/document/d/x/edit', name: 'DashDaoGrowthEngine', govHash: 'ab'.repeat(32) });
    expect(page?.title).toBeNull();
    expect(page?.excerpt).toMatch(/^Turning the Dash DAO/);
  });
});

describe('sameAsName', () => {
  it('ignores case, dashes, underscores and spaces', () => {
    expect(sameAsName('BTC Backports Vijay 04', 'BTCBACKPORTSVIJAY_04')).toBe(true);
    expect(sameAsName('dash-apac-november-december', 'Dash-APAC-November-December')).toBe(true);
    expect(sameAsName('Dash APAC, November to December', 'Dash-APAC-November-December')).toBe(false);
    expect(sameAsName('', '')).toBe(false);
  });
});

describe('parseOwnerPage: DashCentral', () => {
  const ctx = { url: DC, name: 'DCG-Operations-Aug-Nov-26', govHash: HASH };

  it('reads the title row and the first substantive paragraph of the description', () => {
    const html = dashcentral(
      '<strong>Dash Core Group&#8203; August</strong><strong> 21st Funding Proposals</strong><br>\n<br>\n' +
        'This proposal funds Dash Core Group&#39;s ongoing operating costs &mdash; compensation, legal and infrastructure.<br>\n<br>\n' +
        '<strong>What is the proposal funding?</strong><br><br>Second paragraph that is also long enough to qualify as substantive text.',
    );
    expect(parseOwnerPage(html, ctx)).toEqual({
      url: DC,
      host: 'dashcentral.org',
      title: 'Dash Core Group Operations September - December 2026',
      description: null,
      excerpt: "This proposal funds Dash Core Group's ongoing operating costs — compensation, legal and infrastructure.",
    });
  });

  it('skips short, colon- and question-ended and all-bold paragraphs, and splits at blocks and list items', () => {
    const html = dashcentral(
      '<p>Short intro.</p><p>This paragraph is long enough but it ends with a colon, so it introduces something:</p>' +
        '<p>Is this long paragraph a question that ends with a question mark, so it is skipped too?</p>' +
        '<p><b>This whole paragraph is bold, so it is a heading even though it is rather long indeed, yes.</b></p>' +
        '<ul><li>The first list item is a substantive sentence of the proposal text, long enough to count.</li><li>Another item.</li></ul>',
    );
    expect(parseOwnerPage(html, ctx)?.excerpt).toBe('The first list item is a substantive sentence of the proposal text, long enough to count.');
  });

  it('prefers a paragraph that ends a sentence over a list line before it, and falls back to the list line', () => {
    const lead = 'DCG is submitting only one funding proposal for the budget cycle that pays out August 21st:<br>\n<strong>1) DCG Operations: 4,832 Dash per month (currently in month 1/4)</strong>';
    const prose = 'This proposal funds Dash Core Group&#39;s ongoing operating costs, including compensation and infrastructure.';
    expect(parseOwnerPage(dashcentral(`${lead}<br>\n<br>\n${prose}`), ctx)?.excerpt).toBe("This proposal funds Dash Core Group's ongoing operating costs, including compensation and infrastructure.");
    expect(parseOwnerPage(dashcentral(lead), ctx)?.excerpt).toMatch(/^DCG is submitting only one funding proposal/);
  });

  it('stays inside nested divs of the description', () => {
    const html = dashcentral('<div><div>Nested text that is long enough to be the first substantive paragraph of this page.</div></div>');
    expect(parseOwnerPage(html, ctx)?.excerpt).toBe('Nested text that is long enough to be the first substantive paragraph of this page.');
  });

  it('refuses a page that does not carry the proposal hash (unknown slug, front page)', () => {
    expect(parseOwnerPage(dashcentral('<br>Text that is long enough to be a substantive paragraph of the owner.', OTHER), ctx)).toBeNull();
    expect(parseOwnerPage('<html><head><title>DashCentral.org - Dash Governance</title></head><body>Sorry, this proposal does not yet exist!</body></html>', ctx)).toBeNull();
  });

  it('drops a title that is only the name again, keeping the excerpt', () => {
    const html = dashcentral('Text that is long enough to be a substantive paragraph of the owner.').replace(
      'Dash Core Group Operations September - December 2026</td>',
      'DCG Operations Aug Nov 26</td>',
    );
    const page = parseOwnerPage(html, ctx);
    expect(page?.title).toBeNull();
    expect(page?.excerpt).toBe('Text that is long enough to be a substantive paragraph of the owner.');
  });

  it('is null when nothing is usable', () => {
    expect(parseOwnerPage(dashcentral('<strong>Only a heading</strong>').replace(/<tr><td>Title:.*<\/td><\/tr>/, ''), ctx)).toBeNull();
  });

  it('caps the excerpt at a word boundary', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const e = parseOwnerPage(dashcentral(`<br>${long}`), ctx)?.excerpt ?? '';
    expect(e.length).toBeLessThanOrEqual(600);
    expect(e.endsWith('…')).toBe(true);
    expect(long.startsWith(e.slice(0, -1))).toBe(true);
    expect(e.slice(0, -1).split(' ').every((w) => /^word\d+$/.test(w))).toBe(true);
  });

  it('never returns text from something that is not HTML', () => {
    expect(parseOwnerPage(`{"title":"x","proposal":"${HASH}"}`, ctx)).toBeNull();
    expect(parseOwnerPage(`%PDF-1.7 ${HASH}`, ctx)).toBeNull();
  });
});

describe('parseOwnerPage: other pages', () => {
  const ctx = { url: 'https://example.org/vijay', name: 'BTCBACKPORTSVIJAY_04', govHash: HASH };

  it('takes og:title and og:description, and ignores the body', () => {
    const html = `<html><head><title>Ignored</title><meta property="og:title" content="Bitcoin backports &amp; reviews, Vijay" />
      <meta property="og:description" content="Porting upstream Bitcoin Core changes into Dash Core, with review notes."></head><body><p>${'Body text that must not be read. '.repeat(5)}</p></body></html>`;
    expect(parseOwnerPage(html, ctx)).toEqual({
      url: 'https://example.org/vijay',
      host: 'example.org',
      title: 'Bitcoin backports & reviews, Vijay',
      description: 'Porting upstream Bitcoin Core changes into Dash Core, with review notes.',
      excerpt: null,
    });
  });

  it('falls back to <title> and the meta description; a description equal to the title is dropped', () => {
    const a = parseOwnerPage('<html><head><title>Vijay   &ndash; backports</title><meta name="description" content="Notes on the work."></head></html>', ctx);
    expect(a).toMatchObject({ title: 'Vijay – backports', description: 'Notes on the work.' });
    const b = parseOwnerPage('<html><head><title>Vijay backports</title><meta name="description" content="vijay backports"></head></html>', ctx);
    expect(b).toMatchObject({ title: 'Vijay backports', description: null });
  });

  it('drops a title that is the on-chain name and returns null when nothing else is left', () => {
    expect(parseOwnerPage('<html><head><title>btcbackports vijay 04</title></head></html>', ctx)).toBeNull();
    expect(parseOwnerPage('<html><head><title>BTC Backports Vijay 04</title><meta name="description" content="What it does."></head></html>', ctx)).toMatchObject({ title: null, description: 'What it does.' });
  });

  it('is null for sign-in and error pages', () => {
    expect(parseOwnerPage('<html><head><title>Sign in - Google Accounts</title></head></html>', { ...ctx, url: 'https://accounts.google.com/v3/signin' })).toBeNull();
    expect(parseOwnerPage('<html><head><title>Just a moment...</title></head></html>', ctx)).toBeNull();
  });

  it('refuses a non-http(s) page url', () => {
    expect(parseOwnerPage('<html><head><title>Hello there</title></head></html>', { ...ctx, url: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('parseOwnerPage: Google Docs', () => {
  const ctx = { url: 'https://docs.google.com/document/d/1Qx8/edit', name: 'Dash-Music-MVP-Application-Developing', govHash: HASH };

  it('uses og:description as the excerpt, without a leading copy of the title', () => {
    const html = `<html><head><title>Dash Music MVP - Google Docs</title><meta property="og:title" content="Dash Music MVP" />
      <meta property="og:description" content="Dash Music MVP A music app built on Dash Platform, paying artists directly." /></head></html>`;
    expect(parseOwnerPage(html, ctx)).toEqual({
      url: ctx.url,
      host: 'docs.google.com',
      title: 'Dash Music MVP',
      description: null,
      excerpt: 'A music app built on Dash Platform, paying artists directly.',
    });
  });

  it('removes the Google suffix from <title>', () => {
    const page = parseOwnerPage('<html><head><title>Dash Music MVP - Google Docs</title></head></html>', ctx);
    expect(page).toMatchObject({ title: 'Dash Music MVP', excerpt: null });
  });
});

describe('parseOwnerPages', () => {
  const good = { url: 'https://dashcentral.org/p/x', host: 'dashcentral.org', title: 'T', description: null, excerpt: 'E' };

  it('keeps well-formed entries with the fetch time', () => {
    const o = parseOwnerPages({ fetchedAt: 1_793_900_000, pages: { [HASH]: good } });
    expect(o.fetchedAt).toBe(1_793_900_000);
    expect(o.pages.get(HASH)).toEqual(good);
  });

  it('drops anything malformed', () => {
    const bad = {
      [HASH.toUpperCase()]: good,
      ['ab'.repeat(5)]: good,
      [OTHER]: { ...good, url: 'javascript:alert(1)', host: 'x' },
      ['1'.repeat(64)]: { ...good, host: 'evil.example' },
      ['2'.repeat(64)]: { ...good, url: 'https://user:pw@dashcentral.org/p/x' },
      ['3'.repeat(64)]: { ...good, title: 5 },
      ['4'.repeat(64)]: { ...good, title: 'x'.repeat(141) },
      ['5'.repeat(64)]: { ...good, excerpt: 'x'.repeat(601) },
      ['6'.repeat(64)]: { ...good, title: null, excerpt: null },
      ['7'.repeat(64)]: { url: good.url, host: good.host },
      ['8'.repeat(64)]: null,
    };
    expect(parseOwnerPages({ fetchedAt: 1, pages: bad }).pages.size).toBe(0);
  });

  it('is empty for anything that is not the file', () => {
    expect(parseOwnerPages(null).pages.size).toBe(0);
    expect(parseOwnerPages({ pages: { [HASH]: good } }).pages.size).toBe(0);
    expect(parseOwnerPages({ fetchedAt: 'now', pages: { [HASH]: good } }).pages.size).toBe(0);
    expect(parseOwnerPages({ fetchedAt: 1, pages: 'x' }).pages.size).toBe(0);
  });

  it('treats the www. host as the page host', () => {
    expect(parseOwnerPages({ fetchedAt: 1, pages: { [HASH]: { ...good, url: 'https://www.dashcentral.org/p/x' } } }).pages.size).toBe(1);
  });
});
