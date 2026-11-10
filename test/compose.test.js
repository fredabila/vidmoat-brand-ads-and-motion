import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, setupCommands, frameImage, layoutFor, sceneDuration, highlightSpan, FORMATS, STYLES, TRACK_ORDER } from '../server/compose.js';
import { fitFont, estimateText, LOOKS } from '../server/motion.js';

const scene = (over) => ({ kind: 'feature', headline: 'Sleep tracking that explains itself', highlight: 'explains itself', sub: 'A plain summary', image: -1, statValue: 0, statPrefix: '', statSuffix: '', cta: '', ...over });
const storyboard = {
  brandName: 'Tempo <b>', tagline: 'Live more', palette: { background: '#062925', surface: '#0f766e', accent: '#f97316', text: '#f0fdfa' }, musicQuery: 'upbeat',
  scenes: [scene({ kind: 'hook', image: 0, headline: 'Still charging "every" night?' }), scene({ image: 1 }), scene({ image: 0 }),
    scene({ kind: 'stat', headline: 'Runners', statValue: 48000, statSuffix: '+' }), scene({}), scene({ kind: 'cta', headline: 'Live more', cta: 'Shop <now>' })],
};
const images = [{ src: 'https://api.vidmoat.com/uploads/a.jpg', width: 1200, height: 800 }, { src: 'https://api.vidmoat.com/uploads/b.jpg', width: 800, height: 1400 }];
const tracks = { back: 4, media: 5, front: 6 };
const build = (format, style) => compose({
  storyboard, images, logo: { src: 'https://api.vidmoat.com/uploads/l.png', width: 512, height: 512 },
  canvas: FORMATS[format], format, style, tracks, music: { src: 'https://api.vidmoat.com/uploads/m.mp3' }, domain: 'tempo.example.com',
});

for (const format of Object.keys(FORMATS)) {
  for (const style of Object.keys(STYLES)) {
    test(`${format}/${style}: a valid, self-consistent timeline`, () => {
      const { commands, duration, timeline } = build(format, style);
      assert.ok(commands.length <= 150, 'fits one API batch');
      assert.equal(timeline.length, storyboard.scenes.length);
      assert.equal(timeline[0].start, 0);
      assert.ok(Math.abs(timeline.at(-1).start + timeline.at(-1).duration - duration) < 0.01);

      const clips = commands.filter((c) => c.op.startsWith('add'));
      const ids = clips.map((c) => c.clipId);
      assert.equal(new Set(ids).size, ids.length, 'clip ids are unique');
      for (const c of commands) if (c.clipId && !c.op.startsWith('add') && c.op !== 'musicBed') assert.ok(ids.includes(c.clipId), `${c.op} targets a real clip`);

      // Two clips never share a track at the same time (the API would move one).
      for (const track of Object.values(tracks)) {
        const onTrack = clips.filter((c) => c.trackIndex === track).sort((a, b) => a.start - b.start);
        for (let i = 1; i < onTrack.length; i++) assert.ok(onTrack[i].start >= onTrack[i - 1].start + onTrack[i - 1].duration - 0.011, `overlap on track ${track}`);
      }
      // Picture always has a background from the first frame to the last.
      const cover = clips.filter((c) => c.trackIndex === tracks.back || (c.type === 'image' && c.clipId === 's0_img'));
      assert.ok(cover.some((c) => c.start === 0));

      for (const c of clips.filter((x) => x.op === 'addHtmlElement')) {
        const prefix = c.clipId.replace('_back', 'b-').replace('_front', 'f-');
        // The stylesheet is global to the frame: every rule must be namespaced to its clip.
        for (const rule of c.css.split('}').map((r) => r.trim()).filter(Boolean)) assert.ok(rule.startsWith(`.${prefix}`), `unscoped rule: ${rule.slice(0, 60)}`);
        assert.ok(!/<script|javascript:|@import|url\(\s*['"]?http/i.test(c.html + c.css));
        assert.ok(!c.html.includes('<b>') && !c.html.includes('<now>'), 'page text is escaped');
        assert.equal(c.width, FORMATS[format].width);
      }
      for (const c of clips.filter((x) => x.type === 'image')) {
        for (const side of ['cropL', 'cropR', 'cropT', 'cropB']) assert.ok((c.patch[side] ?? 0) <= 28);
        assert.ok(c.patch.scale > 0);
      }
      assert.equal(commands.at(-1).op, 'musicBed');
      assert.equal(commands.at(-1).end, duration);
    });
  }
}

test('setup creates the layer tracks in draw order', () => {
  const cmds = setupCommands('square', '#000000');
  assert.equal(cmds[0].aspectRatio, '1:1');
  assert.deepEqual(cmds.slice(1).map((c) => c.label), TRACK_ORDER);
});

test('pictures are cropped to their frame, never by more than 28% a side', () => {
  const canvas = FORMATS.vertical;
  const wide = frameImage({ width: 3000, height: 1000 }, { x: 0, y: 0, width: 900, height: 900 }, canvas);
  assert.equal(wide.cropX, 28);
  assert.ok(wide.rect.height < 900 && Math.abs(wide.rect.width - 900) < 1);
  const exact = frameImage({ width: 1000, height: 1000 }, { x: 90, y: 500, width: 900, height: 900 }, canvas);
  assert.deepEqual([exact.cropX, exact.cropY, exact.scale], [0, 0, 0.83]);
});

test('headlines shrink to fit and stay readable', () => {
  const box = { width: 912, height: 520 };
  const size = fitFont('Sleep tracking that explains itself every single night', 116, box, LOOKS.sleek);
  const est = estimateText('Sleep tracking that explains itself every single night', size, box.width, LOOKS.sleek.charWidth, LOOKS.sleek.lineHeight);
  assert.ok(est.height <= box.height && est.lines <= 4 && size >= 44);
  assert.ok(fitFont('Go', 116, box, LOOKS.sleek) === 116);
});

test('timing and emphasis helpers', () => {
  assert.ok(sceneDuration(scene({ headline: 'one two three four five six seven eight nine ten', sub: '' })) > sceneDuration(scene({ headline: 'Short', sub: '' })));
  assert.deepEqual(highlightSpan('Sapphire tough display', 'tough display'), { from: 1, to: 2 });
  assert.equal(highlightSpan('Sapphire tough display', 'missing'), null);
  assert.ok(layoutFor('wide', FORMATS.wide).feature.length === 2);
});
