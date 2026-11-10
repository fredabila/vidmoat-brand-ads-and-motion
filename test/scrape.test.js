import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, extractBrief, fetchPage, isPrivateAddress, normalizeUrl, LinkError } from '../server/scrape.js';

const PAGE = `<!doctype html><html><head><title>Tempo One | Tempo</title>
<meta property="og:site_name" content="Tempo"><meta name="description" content="A smartwatch with 14-day battery life.">
<meta property="og:image" content="/img/card.jpg"><meta name="theme-color" content="#0f766e">
<style>.a{color:#f97316}.b{color:#f97316}.c{color:#777777}</style>
<script type="application/ld+json">{"@type":"Product","name":"Tempo One","offers":{"price":"199","priceCurrency":"USD"},"image":["https://cdn.example.com/p.jpg"]}</script>
</head><body><nav><h2>Navigation</h2></nav>
<h1>The watch that lasts 14 days #</h1><p>Tempo One is built for people who would rather live than charge their watch.</p>
<img src="/img/hero.jpg" alt="Watch on a wrist" width="1200" height="800"><img src="/img/pixel.gif" width="1" height="1"><img src="/icons/sprite.png">
<a class="btn">Search</a><a class="btn">Shop Tempo One</a><footer><p>This footer paragraph is long enough to be picked up otherwise.</p></footer></body></html>`;

test('extractBrief pulls identity, text, pictures and colours from a page', () => {
  const brief = extractBrief(PAGE, 'https://www.tempo.example.com/one');
  assert.equal(brief.siteName, 'Tempo');
  assert.equal(brief.domain, 'tempo.example.com');
  assert.equal(brief.themeColor, '#0f766e');
  assert.deepEqual(brief.colors, ['#f97316']); // greys are dropped
  assert.equal(brief.facts.price, 'USD 199');
  assert.deepEqual(brief.headings, ['The watch that lasts 14 days']); // nav heading and anchor mark removed
  assert.ok(!brief.paragraphs.some((p) => p.includes('footer')));
  assert.deepEqual(brief.images.map((i) => i.url), [
    'https://www.tempo.example.com/img/card.jpg', 'https://cdn.example.com/p.jpg', 'https://www.tempo.example.com/img/hero.jpg',
  ]);
  assert.deepEqual(brief.buttons, ['Shop Tempo One']); // "Search" is page furniture
});

test('private and local addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  const lookup = async (host) => [{ address: host === 'evil.example.com' ? '10.0.0.5' : '93.184.216.34' }];
  for (const url of ['http://localhost:3000/', 'http://169.254.169.254/latest', 'ftp://example.com', 'http://intranet/', 'https://user:pw@example.com', 'http://evil.example.com/']) {
    await assert.rejects(assertPublicUrl(url, { lookup, env: {} }), LinkError, url);
  }
  assert.equal((await assertPublicUrl('https://example.com/a', { lookup, env: {} })).hostname, 'example.com');
});

test('an unresolvable host is only let through behind a resolving proxy', async () => {
  const lookup = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(assertPublicUrl('https://example.com', { lookup, env: {} }), LinkError);
  assert.ok(await assertPublicUrl('https://example.com', { lookup, env: { ALLOW_PROXY_DNS: '1' } }));
});

test('every redirect hop is checked again', async () => {
  const seen = [];
  const guard = async (u) => { seen.push(String(u)); if (String(u).includes('169.254')) throw new LinkError('private'); return new URL(u); };
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/meta' } });
  await assert.rejects(fetchPage('example.com', { fetchImpl, guard }), LinkError);
  assert.deepEqual(seen, ['https://example.com', 'http://169.254.169.254/meta']);
});

test('normalizeUrl adds https to a bare host', () => {
  assert.equal(normalizeUrl(' shop.example.com/x '), 'https://shop.example.com/x');
  assert.equal(normalizeUrl('http://a.example'), 'http://a.example');
});
