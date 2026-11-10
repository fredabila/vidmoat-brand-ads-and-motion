// Fetch a pasted link safely and pull out everything an ad needs: who it is,
// what it says, what it looks like.

import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';

const MAX_HTML_BYTES = 2_500_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; LinkReelBot/1.0; +link preview)';

export class LinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkError';
  }
}

// ---------- SSRF guard ----------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower) || lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:');
  }
  return true;
}

/**
 * Throws unless `input` is a public http(s) URL. Resolves the host and refuses
 * private, loopback, link-local and metadata ranges.
 *
 * ALLOW_PROXY_DNS=1 skips the local resolution only (literal IPs and local
 * names are still refused). It is for hosts whose outbound traffic goes through
 * a forward proxy that does the name resolution itself.
 */
export async function assertPublicUrl(input, { lookup = dns.lookup, env = process.env } = {}) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new LinkError('That does not look like a link. Paste a full address, like https://example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkError('Only http and https links work.');
  }
  if (url.username || url.password) throw new LinkError('Links with a username or password are not supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) {
    throw new LinkError('That link points at a private address.');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new LinkError('That link points at a private address.');
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    if (env.ALLOW_PROXY_DNS === '1') return url;
    throw new LinkError(`Could not find ${host}. Check the link and try again.`);
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new LinkError('That link points at a private address.');
  }
  return url;
}

export function normalizeUrl(input) {
  let s = String(input ?? '').trim();
  if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

// ---------- Fetch ----------

async function readLimited(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchPage(input, { fetchImpl = fetch, guard = assertPublicUrl } = {}) {
  let url = await guard(normalizeUrl(input));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LinkError(`Could not reach ${url.hostname}. The site did not answer.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.arrayBuffer().catch(() => {});
      // Every hop is checked again: a public page may redirect to a private one.
      url = await guard(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    if (!res.ok) {
      throw new LinkError(`${url.hostname} answered ${res.status}. The page may be private or blocking automated visits.`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml|text\/plain/i.test(type)) {
      throw new LinkError('That link is a file, not a page. Paste the link to a web page.');
    }
    return { url: url.toString(), html: await readLimited(res, MAX_HTML_BYTES) };
  }
  throw new LinkError('That link redirects too many times.');
}

// ---------- Extract ----------

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\s*[#¶§]+$/, '').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function absolute(src, base) {
  try {
    const u = new URL(src, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const candidates = srcset.split(',').map((part) => {
    const [u, size] = part.trim().split(/\s+/);
    return { u, w: parseFloat(size) || 0 };
  }).filter((c) => c.u);
  candidates.sort((a, b) => b.w - a.w);
  // The biggest candidate is often huge; prefer the first one at or under 1600w.
  return (candidates.find((c) => c.w && c.w <= 1600) ?? candidates[0])?.u ?? null;
}

const JUNK_IMAGE = /(sprite|pixel|tracking|spacer|blank|placeholder|loader|spinner|badge|avatar|emoji|flag|icon[-_/.]|\/icons?\/|1x1|gravatar|doubleclick|googletag|facebook\.com\/tr)/i;

function collectJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
        out.push(node);
      }
    } catch { /* malformed JSON-LD is common; ignore it */ }
  });
  return out;
}

function topColors(html) {
  const counts = new Map();
  const styleText = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? []).join(' ') +
    (html.match(/style="[^"]*"/gi) ?? []).join(' ');
  for (const m of styleText.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // Greys say nothing about a brand.
    if (Math.max(r, g, b) - Math.min(r, g, b) < 28) continue;
    counts.set(`#${hex}`, (counts.get(`#${hex}`) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex]) => hex);
}

/** Turn a page into a brief: text, images, colours. Pure, so it is easy to test. */
export function extractBrief(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (sel) => clean($(sel).first().attr('content'));
  const url = new URL(pageUrl);

  const jsonLd = collectJsonLd($);
  const product = jsonLd.find((n) => /Product/i.test(String(n['@type'])));
  const org = jsonLd.find((n) => /Organization|WebSite|LocalBusiness|Brand/i.test(String(n['@type'])));

  const title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || clean($('title').first().text());
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]') ||
    meta('meta[name="twitter:description"]') || clean(product?.description);
  const siteName = meta('meta[property="og:site_name"]') || clean(org?.name) || meta('meta[name="application-name"]') ||
    url.hostname.replace(/^www\./, '').split('.')[0].replace(/^./, (c) => c.toUpperCase());

  // Images: social card first, then product images, then what is on the page.
  const images = [];
  const seen = new Set();
  const addImage = (src, alt = '', hint = '') => {
    const abs = src && absolute(src, pageUrl);
    if (!abs || seen.has(abs) || images.length >= 14) return;
    if (/^data:/i.test(src) || /\.svg(\?|$)/i.test(abs) || /\.gif(\?|$)/i.test(abs)) return;
    if (!hint && JUNK_IMAGE.test(abs)) return;
    seen.add(abs);
    images.push({ url: abs, alt: clip(clean(alt), 120), hint });
  };
  addImage(meta('meta[property="og:image:secure_url"]') || meta('meta[property="og:image"]'), title, 'social card');
  addImage(meta('meta[name="twitter:image"]') || meta('meta[name="twitter:image:src"]'), title, 'social card');
  for (const img of [].concat(product?.image ?? [])) {
    addImage(typeof img === 'string' ? img : img?.url, clean(product?.name), 'product');
  }
  $('img, picture source').each((_, el) => {
    const $el = $(el);
    const w = Number($el.attr('width')) || 0;
    const h = Number($el.attr('height')) || 0;
    if ((w && w < 200) || (h && h < 120)) return;
    const src = pickFromSrcset($el.attr('srcset') || $el.attr('data-srcset')) ||
      $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src');
    addImage(src, $el.attr('alt') || $el.closest('picture').find('img').attr('alt') || '');
  });

  let logo = null;
  const logoCandidate = (typeof org?.logo === 'string' ? org.logo : org?.logo?.url) ||
    $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').last().attr('href') ||
    $('link[rel~="icon"][sizes="192x192"], link[rel~="icon"][sizes="512x512"]').last().attr('href');
  if (logoCandidate && !/\.svg(\?|$)|\.ico(\?|$)/i.test(logoCandidate)) logo = absolute(logoCandidate, pageUrl);

  // Text, without the chrome.
  $('script, style, noscript, svg, iframe, template, nav, footer, form, [aria-hidden="true"]').remove();
  const uniq = (list, max, maxLen) => {
    const out = [];
    const had = new Set();
    for (const raw of list) {
      const t = clean(raw);
      const key = t.toLowerCase();
      if (t.length < 3 || had.has(key)) continue;
      had.add(key);
      out.push(clip(t, maxLen));
      if (out.length >= max) break;
    }
    return out;
  };
  const texts = (sel) => $(sel).map((_, el) => $(el).text()).get();
  const headings = uniq(texts('h1, h2, h3'), 18, 140);
  const paragraphs = uniq(texts('p').filter((t) => clean(t).length > 40), 12, 320);
  const bullets = uniq(texts('li').filter((t) => { const c = clean(t); return c.length > 12 && c.length < 160; }), 12, 160);
  // Buttons that are page furniture make bad calls to action.
  const FURNITURE = /search|menu|log ?in|sign ?in|cookie|accept|close|toggle|subscribe|copy|share|next|prev|skip|ctrl|⌘/i;
  const buttons = uniq(texts('a[class*="btn"], a[class*="button"], a[class*="cta"], button')
    .filter((t) => { const c = clean(t); return c.length < 28 && !FURNITURE.test(c); }), 6, 28);

  // What customers said, where the page marks it up as such.
  const quotes = uniq(texts('blockquote, [class*="testimonial"] p, [class*="review"] p, [class*="quote"] p, q')
    .filter((t) => { const c = clean(t); return c.length > 24 && c.length < 240; }), 4, 240);

  const offer = [].concat(product?.offers ?? [])[0];
  const facts = {};
  if (product?.name) facts.productName = clean(product.name);
  if (offer?.price) facts.price = clean(`${offer.priceCurrency ?? ''} ${offer.price}`);
  const rating = product?.aggregateRating;
  if (rating?.ratingValue) {
    facts.rating = clean(`${rating.ratingValue} out of ${rating.bestRating ?? 5}` +
      (rating.reviewCount || rating.ratingCount ? ` from ${rating.reviewCount ?? rating.ratingCount} reviews` : ''));
  }

  return {
    url: pageUrl,
    domain: url.hostname.replace(/^www\./, ''),
    siteName: clip(siteName, 60),
    title: clip(title, 160),
    description: clip(description, 400),
    themeColor: (meta('meta[name="theme-color"]').match(/^#[0-9a-f]{3,8}$/i) ?? [null])[0],
    colors: topColors(html),
    headings,
    paragraphs,
    bullets,
    quotes,
    buttons,
    facts,
    images,
    logo,
  };
}

/** Everything the page says, flattened. Used to check claims against the source. */
export function briefText(brief) {
  return [brief.siteName, brief.title, brief.description, ...brief.headings, ...brief.paragraphs,
    ...brief.bullets, ...(brief.quotes ?? []), ...Object.values(brief.facts ?? {})].join(' \n ');
}

export async function readLink(input, deps) {
  const { url, html } = await fetchPage(input, deps);
  const brief = extractBrief(html, url);
  if (!brief.title && !brief.description && !brief.headings.length) {
    throw new LinkError('That page has no readable text. It may need a login or be built entirely in the browser.');
  }
  return brief;
}
