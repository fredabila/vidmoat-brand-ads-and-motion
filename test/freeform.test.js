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

test('with Claude as art director a designed scene owns the frame', () => {
  const design = sanitizeDesign({ ...good, background: 'linear-gradient(160deg,var(--bg),var(--surface))', mediaBox: { x: 90, y: 900, width: 900, height: 700 } });
  assert.equal(design.background, 'linear-gradient(160deg,var(--bg),var(--surface))');
  assert.deepEqual(design.mediaBox, { x: 90, y: 900, width: 900, height: 700 });
  // A background that tries to close the rule or fetch something is dropped, not trusted.
  assert.equal(sanitizeDesign({ ...good, background: 'red;} body{display:none' }).background, '');
  assert.equal(sanitizeDesign({ ...good, background: 'url(https://x.example/a.png)' }).background, '');
  assert.equal(sanitizeDesign({ ...good, mediaBox: { x: 0, y: 0, width: 0, height: 0 } }).mediaBox, null);

  const blank = { highlight: '', sub: '', items: [], footage: -1, voice: '' };
  const sb = {
    brandName: 'T', tagline: 't', musicQuery: 'x', directed: true,
    direction: { concept: 'c', motif: 'm', headFont: 'Bebas Neue', bodyFont: 'Space Mono', transition: 'cut' },
    palette: { background: '#101010', surface: '#202020', accent: '#ff5500', text: '#ffffff' },
    scenes: [
      { ...blank, kind: 'hook', headline: 'Hi', image: 0, design },
      { ...blank, kind: 'feature', headline: 'Plain', image: -1 }, // its design failed: the template draws it
      { ...blank, kind: 'cta', headline: 'Go', image: -1, cta: 'Go', design: sanitizeDesign(good) },
    ],
  };
  const { commands } = compose({ storyboard: sb, logo: { src: 'https://api.vidmoat.com/uploads/l.png', width: 512, height: 512 }, images: [{ src: 'https://api.vidmoat.com/uploads/a.jpg', width: 1200, height: 800 }], canvas: FORMATS.vertical, format: 'vertical', style: 'sleek', tracks: { back: 4, media: 5, front: 6 } });
  const get = (id) => commands.find((c) => c.clipId === id);
  assert.match(get('s0_back').html, /background:linear-gradient\(160deg,var\(--bg\),var\(--surface\)\)/);
  assert.match(get('s2_back').html, /background:var\(--bg\)/); // no background given: the brand colour
  // The picture sits in the box the designer asked for (centre of 90..990 x 900..1600 on a 1080 x 1920 canvas).
  assert.equal(get('s0_img').patch.x, 0);
  assert.ok(Math.abs(get('s0_img').patch.y - 290) <= 2);
  const front = get('s0_front');
  assert.ok(!front.html.includes('f-sgs') && !front.html.includes('f-wp'), 'no brand bar and, with hard cuts, no wipe panels');
  assert.match(front.css, /font-family:'Bebas Neue'/);
  assert.match(front.css, /font-family:'Space Mono'/);
  assert.equal(get('s2_logo'), undefined, 'no logo is added to a closing card Claude owns');
  // The scene without a design still gets the template: its own background and brand bar.
  assert.match(get('s1_front').html, /s1f-sgs/);
  for (const c of commands.filter((x) => x.op === 'addHtmlElement')) {
    const prefix = c.clipId.replace('_back', 'b-').replace('_front', 'f-');
    for (const rule of c.css.split('}').map((r) => r.trim()).filter(Boolean)) assert.ok(rule.startsWith(`.${prefix}`), rule.slice(0, 50));
  }
});

test('an owned scene with a picture shows it to the designer inline, and says so if it had to be dropped', async () => {
  const ctx = {
    scene: { kind: 'feature', headline: 'x', brief: 'y', sub: '', items: [], voice: '' }, canvas: FORMATS.vertical, safe: { x: 0, y: 0, width: 1, height: 1 },
    palette: { background: '#000000', surface: '#111111', accent: '#ff0000', text: '#ffffff' }, brand: 'T',
    direction: { concept: 'c', motif: 'm', headFont: 'Inter', bodyFont: 'Inter', transition: 'cut' }, index: 1, count: 3, neighbours: {}, media: 'one picture',
    picture: { type: 'base64', media_type: 'image/png', data: 'AQID' },
  };
  const sent = [];
  const ok = { beta: { messages: { parse: async (req) => { sent.push(req.messages[0].content.find((b) => b.type === 'image')?.source); return { stop_reason: 'end_turn', content: [], parsed_output: good }; } } } };
  const out = await designScene(ok, ctx);
  assert.ok(out.design && !out.pictureDropped);
  assert.deepEqual(sent, [ctx.picture]);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  let calls = 0;
  const flaky = { beta: { messages: { parse: async (req) => {
    calls += 1;
    if (req.messages[0].content.some((b) => b.type === 'image')) throw new Anthropic.BadRequestError(400, { error: { message: 'bad image' } }, 'bad image', new Headers());
    return { stop_reason: 'end_turn', content: [], parsed_output: good };
  } } } };
  const dropped = await designScene(flaky, ctx);
  assert.ok(dropped.design);
  assert.match(dropped.pictureDropped, /bad image/);
  assert.equal(calls, 2);
});
