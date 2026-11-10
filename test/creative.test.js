import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStoryboard, heuristicStoryboard, numberInText, fixPalette, contrast, writeStoryboard, buildUserPrompt } from '../server/creative.js';

const brief = {
  url: 'https://tempo.example.com/one', domain: 'tempo.example.com', siteName: 'Tempo', title: 'Tempo One — the everyday smartwatch',
  description: 'A smartwatch with 14-day battery life.', themeColor: '#0f766e', colors: ['#f97316'],
  headings: ['Lasts 14 days', 'Loved by 48,000 runners'], paragraphs: ['Over 48,000 runners train with Tempo every week.'],
  bullets: ['Water resistant to 50 metres'], buttons: ['Shop Tempo One'], facts: {}, images: [{ alt: 'watch' }, { alt: 'wrist' }], logo: null,
};
const scene = (over) => ({ kind: 'feature', headline: 'A headline', highlight: '', sub: '', image: -1, statValue: 0, statPrefix: '', statSuffix: '', cta: '', ...over });

test('numbers are checked against the page', () => {
  assert.ok(numberInText(48000, 'Loved by 48,000 runners'));
  assert.ok(numberInText(14, 'lasts 14 days'));
  assert.ok(!numberInText(90, 'lasts 14 days'));
  assert.ok(!numberInText(0, 'zero 0'));
});

test('a counter the page does not back up becomes an ordinary scene', () => {
  const sb = sanitizeStoryboard({
    brandName: 'Tempo', tagline: 'Live more', palette: {}, musicQuery: 'upbeat',
    scenes: [scene({ kind: 'hook' }), scene({ kind: 'stat', headline: 'Off today', statValue: 90, statSuffix: '%' }),
      scene({ kind: 'stat', headline: 'Runners', statValue: 48000, statSuffix: '+' }), scene({ kind: 'cta', cta: 'Shop now' })],
  }, brief, { sceneCount: 4 });
  assert.deepEqual(sb.scenes.map((s) => s.kind), ['hook', 'feature', 'stat', 'cta']);
  assert.equal(sb.scenes[1].statValue, 0);
  assert.equal(sb.scenes[2].statValue, 48000);
});

test('the storyboard is forced into shape: hook first, cta last, bounded text, valid images', () => {
  const sb = sanitizeStoryboard({
    brandName: 'Tempo', tagline: '', palette: { background: 'red', accent: '#F97316' },
    scenes: [scene({ image: 7, headline: 'One two three four five six seven eight nine ten eleven.' }), scene({ highlight: 'not in headline' }), scene({ image: 1 })],
  }, brief, { sceneCount: 4 });
  assert.equal(sb.scenes[0].kind, 'hook');
  assert.equal(sb.scenes.at(-1).kind, 'cta');
  assert.equal(sb.scenes.at(-1).cta, 'Learn more');
  assert.equal(sb.scenes.length, 4);
  assert.equal(sb.scenes[1].image, -1); // out of range
  assert.equal(sb.scenes[1].headline.split(' ').length, 8);
  assert.equal(sb.scenes[2].highlight, '');
  assert.equal(sb.palette.accent, '#f97316');
  assert.match(sb.palette.background, /^#[0-9a-f]{6}$/);
});

test('unreadable colours are repaired', () => {
  const p = fixPalette({ background: '#101010', surface: '#202020', accent: '#141414', text: '#222222' });
  assert.ok(contrast(p.text, p.background) >= 4.5);
  assert.ok(contrast(p.accent, p.background) >= 2.2);
});

test('without Claude the page writes its own storyboard', async () => {
  const sb = heuristicStoryboard(brief, { sceneCount: 4 });
  assert.equal(sb.scenes[0].kind, 'hook');
  assert.equal(sb.scenes.at(-1).cta, 'Shop Tempo One');
  const out = await writeStoryboard(brief, { length: 'short', client: undefined });
  assert.ok(['claude', 'fallback'].includes(out.source));
});

test('Claude is asked for structured output and a refusal falls back', async () => {
  let request;
  const answer = { stop_reason: 'end_turn', parsed_output: { brandName: 'Tempo', tagline: 'Live more', palette: {}, musicQuery: 'calm', scenes: [scene({ kind: 'hook' }), scene({ kind: 'cta', cta: 'Shop' })] } };
  const client = { beta: { messages: { parse: async (req) => { request = req; return answer; } } } };
  const ok = await writeStoryboard(brief, { length: 'short', client });
  assert.equal(ok.source, 'claude');
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.fallbacks, 'default');
  assert.ok(request.output_config.format);
  assert.match(request.messages[0].content, /<page>[\s\S]*Tempo One[\s\S]*<\/page>/);
  const refused = await writeStoryboard(brief, { length: 'short', client: { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } } } });
  assert.equal(refused.source, 'fallback');
});

test('the prompt lists images by number', () => {
  assert.match(buildUserPrompt(brief, { goal: 'ad', sceneCount: 6, format: 'Vertical 9:16' }), /0: watch\n1: wrist/);
});
