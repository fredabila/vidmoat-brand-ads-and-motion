import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDesign, scopeDesign, designScene } from '../server/freeform.js';
import { sanitizeStoryboard } from '../server/creative.js';
import { compose, FORMATS } from '../server/compose.js';

const good = {
  html: '<div class="sc-root"><p class="sc-a extra" onclick="x()" style="opacity:clamp(0,calc((var(--vm-t) - .5) / .4),1)">Before</p><svg viewBox="0 0 10 10" class="sc-s"><path d="M0 0L10 10" stroke="var(--accent)" pathLength="1"/></svg></div>',
  css: '.sc-root{position:absolute;left:0;top:0;width:100%;height:100%}\n.sc-a,.sc-root .sc-s{color:var(--text);transform:translateY(calc((1 - pow(1 - var(--vm-p),4)) * 40px))}\n.sc-a::after{content:""}',
};

test('a well-formed design passes, with stray classes and handlers stripped', () => {
  const out = sanitizeDesign(good);
  assert.ok(out);
  assert.ok(!out.html.includes('onclick') && !out.html.includes('extra'));
  assert.match(out.html, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(out.html, /viewBox/);
  const scoped = scopeDesign(out, 's3f-');
  assert.ok(!scoped.html.includes('sc-') && !scoped.css.includes('.sc-'));
  assert.match(scoped.css, /^\.s3f-root\{/);
});

test('anything that loads, runs, escapes its namespace or uses the wall clock is refused', () => {
  const bad = [
    { html: '<div class="sc-root"><script>alert(1)</script></div>' },
    { html: '<div class="sc-root"><img src="https://x.example/a.png"></div>' },
    { html: '<div class="sc-root"><iframe></iframe></div>' },
    { html: '<div class="sc-root" style="background:url(https://x.example/a.png)">x</div>' },
    { html: '<div class="sc-root" style="transition:all 1s">x</div>' },
    { css: '.sc-root{background:url("https://x.example")}' },
    { css: '@import "https://x.example/a.css";.sc-root{color:red}' },
    { css: '@keyframes k{from{opacity:0}}.sc-root{opacity:1}' },
    { css: '.sc-root{animation:k 1s}' },
    { css: 'body{display:none}' },
    { css: 'div.sc-root{color:red}' },
    { css: '.sc-root, .other{color:red}' },
    { css: '*{color:red}' },
    { css: '.sc-root{position:fixed}' },
    { css: '.sc-root{color:red}}body{display:none' },
    { html: '<div class="root">no namespace</div>' },
    { html: '<div class="sc-root">a still, no timeline</div>', css: '.sc-root{color:red}' },
  ];
  for (const part of bad) assert.equal(sanitizeDesign({ ...good, ...part }), null, JSON.stringify(part));
  assert.equal(sanitizeDesign(null), null);
  assert.equal(sanitizeDesign({ html: 'x'.repeat(20000), css: '' }), null);
});

test('a custom scene needs a brief before it is designed and a valid design after', () => {
  const brief = { images: [], siteName: 'T', title: 'T', description: '', headings: [], paragraphs: [], bullets: [], facts: {}, domain: 't.example' };
  const scene = (over) => ({ kind: 'custom', headline: 'Before and after', highlight: '', sub: '', items: [], image: -1, visual: '', voice: '', statValue: 0, statPrefix: '', statSuffix: '', cta: '', brief: '', ...over });
  const run = (scenes, opts) => sanitizeStoryboard({ brandName: 'T', tagline: 't', palette: {}, scenes: [scene({ kind: 'hook' }), ...scenes, scene({ kind: 'cta' })] }, brief, { sceneCount: 2 + scenes.length, ...opts }).scenes.slice(1, -1);
  assert.deepEqual(run([scene({ brief: 'Two columns.' }), scene({})], { allowCustom: true }).map((s) => s.kind), ['custom', 'feature']);
  assert.deepEqual(run([scene({ brief: 'Two columns.' })], { allowCustom: false }).map((s) => s.kind), ['feature']);
  // On a rebuild the design comes back from the browser: it goes through the gate again.
  assert.deepEqual(run([scene({ design: good }), scene({ design: { html: '<script>1</script>', css: '' } })], { trustNumbers: true }).map((s) => s.kind), ['custom', 'feature']);
});

test('a designed scene is placed in its clip namespace with the palette as variables', () => {
  const design = sanitizeDesign(good);
  const sb = {
    brandName: 'T', tagline: 't', palette: { background: '#101010', surface: '#202020', accent: '#ff5500', text: '#ffffff' }, musicQuery: 'x',
    scenes: [
      { kind: 'hook', headline: 'Hi', highlight: '', sub: '', items: [], image: -1, footage: -1, voice: '' },
      { kind: 'custom', headline: 'Before and after', highlight: '', sub: '', items: [], image: -1, footage: -1, voice: '', design },
      { kind: 'cta', headline: 'Go', highlight: '', sub: '', items: [], image: -1, footage: -1, voice: '', cta: 'Go' },
    ],
  };
  const { commands } = compose({ storyboard: sb, canvas: FORMATS.vertical, format: 'vertical', style: 'sleek', tracks: { back: 4, media: 5, front: 6 } });
  const front = commands.find((c) => c.clipId === 's1_front');
  assert.match(front.html, /--accent:#[0-9a-f]{6}/);
  assert.match(front.html, /class="s1f-root"/);
  assert.ok(!front.html.includes('sc-') && !front.css.includes('.sc-'));
  for (const rule of front.css.split('}').map((r) => r.trim()).filter(Boolean)) assert.ok(rule.startsWith('.s1f-'), rule.slice(0, 50));
});

test('a design that fails the gate comes back as null, never an exception', async () => {
  const ctx = { scene: { headline: 'x', brief: 'y' }, canvas: FORMATS.vertical, safe: { x: 0, y: 0, width: 1, height: 1 }, palette: { background: '#000000', surface: '#111111', accent: '#ff0000', text: '#ffffff' }, look: { headFont: 'Inter', headWeight: 800, mood: 'm' }, brand: 'T' };
  const client = (out) => ({ beta: { messages: { parse: async () => ({ content: [], ...out }) } } });
  const bad = await designScene(client({ stop_reason: 'end_turn', parsed_output: { html: '<script>1</script>', css: '' } }), ctx);
  assert.equal(bad.design, null);
  assert.match(bad.reason, /not allowed/);
  // A refused design gets one correction round, with the reason, and the fixed one is used.
  const turns = [];
  const fixer = { beta: { messages: { parse: async (req) => { turns.push(req.messages.length); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], parsed_output: turns.length === 1 ? { ...good, css: 'body{color:red}' } : good }; } } } };
  const fixed = await designScene(fixer, ctx);
  assert.ok(fixed.design);
  assert.deepEqual(turns, [1, 3]);
  assert.equal((await designScene(client({ stop_reason: 'refusal', parsed_output: null }), ctx)).design, null);
  assert.equal((await designScene({ beta: { messages: { parse: async () => { throw new Error('boom'); } } } }, ctx)).design, null);
  assert.ok((await designScene(client({ stop_reason: 'end_turn', parsed_output: good }), ctx)).design);
});
