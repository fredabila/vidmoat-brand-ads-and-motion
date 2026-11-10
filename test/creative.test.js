import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { sanitizeStoryboard, heuristicStoryboard, numberInText, fixPalette, contrast, writeStoryboard, buildUserPrompt, buildUserContent } from '../server/creative.js';

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
  assert.match(request.messages[0].content[0].text, /<page>[\s\S]*Tempo One[\s\S]*<\/page>/);
  const refused = await writeStoryboard(brief, { length: 'short', client: { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } } } });
  assert.equal(refused.source, 'fallback');
});

test('the prompt lists images by number', () => {
  assert.match(buildUserPrompt(brief, { goal: 'ad', sceneCount: 6, format: 'Vertical 9:16' }), /0: watch\n1: wrist/);
});

test('Claude is shown the pictures, labelled by index, and unreadable ones do not sink the script', async () => {
  const inline = (data) => ({ type: 'base64', media_type: 'image/jpeg', data });
  const withPics = { ...brief, images: [
    { alt: 'watch', src: 'https://api.vidmoat.com/uploads/a.jpg', vision: inline('AAAA') },
    { alt: 'vector', src: 'https://api.vidmoat.com/uploads/b.avif', vision: null }, // a format Claude cannot read: described only
    { alt: 'wrist', src: 'https://api.vidmoat.com/uploads/c.webp', vision: inline('BBBB') },
  ] };
  const content = buildUserContent(withPics, { goal: 'ad', sceneCount: 4, format: 'Vertical 9:16' });
  // Pictures go inline as bytes, never as a link for the API to fetch.
  assert.deepEqual(content.slice(1).map((b) => b.type === 'text' ? b.text : `${b.source.type}:${b.source.data}`), [
    'Image 0:', 'base64:AAAA', 'Image 2:', 'base64:BBBB',
  ]);

  const seen = [];
  const answer = { stop_reason: 'end_turn', parsed_output: { brandName: 'Tempo', tagline: 'x', palette: {}, musicQuery: 'calm', scenes: [scene({ kind: 'hook', image: 2 }), scene({ kind: 'cta' })] } };
  const client = { beta: { messages: { parse: async (req) => {
    seen.push(req.messages[0].content.filter((b) => b.type === 'image').length);
    if (seen.length === 1) throw new Anthropic.BadRequestError(400, { error: { message: 'could not process image' } }, 'could not process image', new Headers());
    return answer;
  } } } };
  const out = await writeStoryboard(withPics, { length: 'short', client });
  assert.deepEqual(seen, [2, 0]);
  assert.equal(out.source, 'claude');
  assert.equal(out.storyboard.scenes[0].image, 2);
  // The fallback is not silent: the result says the script was written without the pictures.
  assert.match(out.picturesNote, /without seeing the pictures/);
});

test('a picture is sent inline with the type its bytes say it is', async () => {
  const { visionSource } = await import('../server/pipeline.js');
  const bytes = Buffer.from([1, 2, 3]);
  assert.deepEqual(visionSource(bytes, 'jpg'), { type: 'base64', media_type: 'image/jpeg', data: 'AQID' });
  assert.equal(visionSource(bytes, 'webp').media_type, 'image/webp');
  assert.equal(visionSource(bytes, 'avif'), null); // not a format Claude reads
  assert.equal(visionSource(Buffer.alloc(3_700_000), 'png'), null); // too large to send
});
