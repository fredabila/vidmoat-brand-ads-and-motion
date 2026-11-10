// Storyboard -> Vidmoat timeline commands. Pure: no network, no clock, so the
// same storyboard always produces the same edit and the whole thing is testable.
//
// Each scene is three clips stacked on three tracks:
//   back   an HTML graphic: background, moving decor, the plate under the picture
//   media  the page's picture, cropped to its frame and revealed with a mask
//   front  an HTML graphic: kinetic type, counters, the button, the scene wipes
// The design itself lives in motion.js. This file decides timing and geometry.
//
// Facts this relies on, each checked against the live API:
// - Positions are pixel offsets from the canvas centre.
// - An image at scale 1 is contain-fitted to the canvas, after its crop.
// - Crops are percentages of the source, per side.
// - A mask is given in fractions of the canvas, centred on (x, y).
// - Draw order is the order of the tracks array; two clips cannot overlap on one track.

import { LOOKS, backLayer, frontLayer } from './motion.js';

export { highlightSpan, estimateText } from './motion.js';

export const FORMATS = {
  vertical: { aspectRatio: '9:16', width: 1080, height: 1920, label: 'Vertical 9:16', hint: 'Reels, TikTok, Shorts' },
  square: { aspectRatio: '1:1', width: 1080, height: 1080, label: 'Square 1:1', hint: 'Feed posts' },
  wide: { aspectRatio: '16:9', width: 1920, height: 1080, label: 'Wide 16:9', hint: 'YouTube, websites' },
};

export const STYLES = {
  punch: { label: 'Punch', hint: 'Condensed type that slams in, slab wipes' },
  sleek: { label: 'Sleek', hint: 'Soft light, fine grid, calm reveals' },
  playful: { label: 'Playful', hint: 'Round type that pops, spinning shapes' },
};

/** Created in this order after the default tracks, so later names draw on top. */
export const TRACK_ORDER = ['back', 'media', 'front'];

const round = (n) => Math.round(n * 100) / 100;

export function mix(a, b, t) {
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('');
}

/** Long enough to read: a base per kind, plus time for every word past six. */
export function sceneDuration(scene) {
  const base = { hook: 2.9, feature: 3.4, stat: 3.6, cta: 4.4 }[scene.kind] ?? 3.2;
  const wordCount = `${scene.headline} ${scene.sub}`.split(/\s+/).filter(Boolean).length;
  return round(Math.min(base + Math.max(wordCount - 6, 0) * 0.16, 5.2));
}

/** Where things go on each canvas. Regions are {x, y, width, height} from the top-left. */
export function layoutFor(formatKey, canvas) {
  const { width: W, height: H } = canvas;
  if (formatKey === 'wide') {
    const m = 110;
    const col = { y: 190, width: 800, height: 720 };
    return {
      frame: { margin: m, top: 64, brandSize: 26 }, subSize: 40, buttonSize: 52,
      heroSize: 176, headSize: 108, soloSize: 150, statSize: 330, ctaSize: 124,
      hook: { x: m, y: 200, width: 1300, height: 700 },
      solo: { x: m, y: 200, width: 1400, height: 700 },
      stat: { x: m, y: 190, width: 1500, height: 740 },
      cta: { x: 260, y: 170, width: W - 520, height: 780 },
      feature: [
        { text: { x: m, ...col }, image: { x: W - m - 800, y: 170, width: 800, height: 760 }, align: 'center' },
        { text: { x: W - m - 800, ...col }, image: { x: m, y: 170, width: 800, height: 760 }, align: 'center' },
      ],
    };
  }
  if (formatKey === 'square') {
    const m = 72;
    const w = W - m * 2;
    return {
      frame: { margin: m, top: 56, brandSize: 24 }, subSize: 36, buttonSize: 48,
      heroSize: 150, headSize: 88, soloSize: 128, statSize: 300, ctaSize: 104,
      hook: { x: m, y: 170, width: w, height: 800 },
      solo: { x: m, y: 170, width: w, height: 800 },
      stat: { x: m, y: 170, width: w, height: 800 },
      cta: { x: m, y: 150, width: w, height: 840 },
      feature: [
        { text: { x: m, y: 160, width: w, height: 300 }, image: { x: m, y: 500, width: w, height: 500 }, align: 'end' },
        { text: { x: m, y: 700, width: w, height: 300 }, image: { x: m, y: 160, width: w, height: 500 }, align: 'start' },
      ],
    };
  }
  const m = 84;
  const w = W - m * 2;
  return {
    frame: { margin: m, top: 96, brandSize: 28 }, subSize: 44, buttonSize: 56,
    heroSize: 184, headSize: 116, soloSize: 164, statSize: 380, ctaSize: 128,
    hook: { x: m, y: 300, width: w, height: 1330 },
    solo: { x: m, y: 300, width: w, height: 1330 },
    stat: { x: m, y: 300, width: w, height: 1330 },
    cta: { x: m, y: 280, width: w, height: 1400 },
    feature: [
      { text: { x: m, y: 250, width: w, height: 520 }, image: { x: m, y: 840, width: w, height: 880 }, align: 'end' },
      { text: { x: m, y: 1200, width: w, height: 520 }, image: { x: m, y: 250, width: w, height: 880 }, align: 'start' },
    ],
  };
}

/**
 * Fill `region` with the picture: crop the long side (never more than 28% from
 * each edge, so the subject survives) and shrink the frame to what is left.
 */
export function frameImage(image, region, canvas) {
  const want = region.width / region.height;
  const have = image.width / image.height;
  const MAX = 28;
  let cropX = 0;
  let cropY = 0;
  if (have > want) cropX = Math.min((1 - want / have) * 50, MAX);
  else cropY = Math.min((1 - have / want) * 50, MAX);
  const cw = image.width * (1 - (2 * cropX) / 100);
  const ch = image.height * (1 - (2 * cropY) / 100);
  const k = Math.min(region.width / cw, region.height / ch);
  const width = cw * k;
  const height = ch * k;
  const fitted = Math.min(canvas.width / cw, canvas.height / ch); // what scale 1 means
  const rect = { x: region.x + (region.width - width) / 2, y: region.y + (region.height - height) / 2, width, height };
  return { rect, cropX: round(cropX), cropY: round(cropY), scale: round(k / fitted) };
}

/**
 * @param {object} input
 * @param {object} input.storyboard  sanitised storyboard (see creative.js)
 * @param {Array<{src:string,width:number,height:number}>} input.images  indexed like storyboard image numbers
 * @param {{src:string,width:number,height:number}|null} input.logo
 * @param {{width:number,height:number}} input.canvas  the project's real settings
 * @param {string} input.format  key of FORMATS
 * @param {string} input.style  key of STYLES
 * @param {Record<string, number>} input.tracks  track name -> track id
 * @param {{src:string}|null} input.music
 * @param {string} input.domain
 */
export function compose({ storyboard, images = [], logo = null, canvas, format = 'vertical', style = 'sleek', tracks, music = null, domain = '' }) {
  const lookName = LOOKS[style] ? style : 'sleek';
  const look = LOOKS[lookName];
  const layout = layoutFor(format, canvas);
  const { width: W, height: H } = canvas;
  const palette = storyboard.palette;
  const count = storyboard.scenes.length;
  const commands = [];
  const timeline = [];
  const push = (cmd) => commands.push(cmd);
  const centre = (rect) => ({ x: Math.round(rect.x + rect.width / 2 - W / 2), y: Math.round(rect.y + rect.height / 2 - H / 2) });

  let t = 0;
  let featureIndex = 0;
  storyboard.scenes.forEach((scene, i) => {
    const id = `s${i}`;
    const last = i === count - 1;
    // The closing card holds a little longer so the button can be read.
    const d = round(sceneDuration(scene) + (last ? 0.4 : 0));
    const image = scene.image >= 0 ? images[scene.image] : null;
    timeline.push({ index: i, kind: scene.kind, start: round(t), duration: d });
    const enter = i > 0 ? 0.42 : 0; // how long the incoming wipe covers the frame

    let plate = null;
    let textRegion = null;
    let textAlign = 'center';
    const showImage = Boolean(image) && (scene.kind === 'hook' || scene.kind === 'feature');

    if (showImage && scene.kind === 'feature') {
      const slot = layout.feature[featureIndex % layout.feature.length];
      featureIndex += 1;
      textRegion = slot.text;
      textAlign = slot.align;
      const framed = frameImage(image, slot.image, canvas);
      const at = enter + 0.12;
      plate = { ...Object.fromEntries(Object.entries(framed.rect).map(([k, v]) => [k, Math.round(v)])), at };
      const pos = centre(framed.rect);
      push({
        op: 'addClip', clipId: `${id}_img`, type: 'image', src: image.src, start: round(t), duration: d, trackIndex: tracks.media,
        patch: { ...pos, scale: framed.scale, cornerRadius: look.radius, cropL: framed.cropX, cropR: framed.cropX, cropT: framed.cropY, cropB: framed.cropY },
      });
      // Reveal: a mask that opens from the middle of the frame, then a slow push for the rest of the scene.
      const mx = (framed.rect.x + framed.rect.width / 2) / W;
      const my = (framed.rect.y + framed.rect.height / 2) / H;
      const tall = framed.rect.height >= framed.rect.width;
      push({
        op: 'setMask', clipId: `${id}_img`,
        patch: { shape: 'rectangle', x: round(mx), y: round(my), width: tall ? 1.5 : 0, height: tall ? 0 : 1.5, feather: 0 },
      });
      push({
        op: 'setKeyframeTrack', clipId: `${id}_img`, prop: tall ? 'maskHeight' : 'maskWidth',
        keyframes: [{ time: round(at), value: 0 }, { time: round(at + 0.8), value: 1.5, easing: 'easeOutExpo' }],
      });
      push({
        op: 'setKeyframeTrack', clipId: `${id}_img`, prop: 'scale',
        keyframes: [
          { time: round(at), value: round(framed.scale * 1.12) },
          { time: round(at + 0.9), value: framed.scale, easing: 'easeOutExpo' },
          { time: d, value: round(framed.scale * 1.035), easing: 'linear' },
        ],
      });
    } else if (showImage) {
      // Opening shot: the picture fills the frame and drifts under the words.
      const cover = round(Math.max(W / image.width, H / image.height) / Math.min(W / image.width, H / image.height));
      push({ op: 'addClip', clipId: `${id}_img`, type: 'image', src: image.src, start: round(t), duration: d, trackIndex: tracks.media, patch: { scale: cover } });
      push({
        op: 'setKeyframeTrack', clipId: `${id}_img`, prop: 'scale',
        keyframes: [{ time: 0, value: round(cover * 1.16) }, { time: d, value: cover, easing: 'easeOutCubic' }],
      });
      // Social cards carry their own words; soften those further so they do not fight the headline.
      push({ op: 'setColor', clipId: `${id}_img`, patch: { blur: image.hint === 'social card' ? 14 : 3, saturation: 85, brightness: 68 } });
    }

    if (scene.kind === 'cta' && logo) {
      // The mark sits above the closing line and settles in with a small overshoot.
      const size = Math.round(Math.min(W, H) * 0.15);
      const rect = { x: (W - size) / 2, y: layout.cta.y - size * 0.1, width: size, height: size };
      const fit = frameImage(logo, rect, canvas);
      const pos = centre(fit.rect);
      push({ op: 'addClip', clipId: `${id}_logo`, type: 'image', src: logo.src, start: round(t + enter), duration: round(d - enter), trackIndex: tracks.media, patch: { ...pos, scale: fit.scale, cornerRadius: 28 } });
      push({ op: 'setKeyframeTrack', clipId: `${id}_logo`, prop: 'scale', keyframes: [{ time: 0, value: round(fit.scale * 0.4) }, { time: 0.55, value: fit.scale, easing: 'easeOutBack' }] });
      push({ op: 'setKeyframeTrack', clipId: `${id}_logo`, prop: 'opacity', keyframes: [{ time: 0, value: 0 }, { time: 0.2, value: 1 }] });
    }

    const shared = { look, lookName, palette, canvas, index: i, brand: storyboard.brandName };
    // A full-bleed opening picture hides the background, so none is laid under it.
    const back = backLayer(`${id}b-`, { ...shared, plate });
    if (!(showImage && scene.kind === 'hook')) push({ op: 'addHtmlElement', clipId: `${id}_back`, name: `Scene ${i + 1} background`, html: back.html, css: back.css, width: W, height: H, start: round(t), duration: d, trackIndex: tracks.back });

    // With a logo on the closing card, the words move down to make room for it.
    const ctaLayout = scene.kind === 'cta' && logo
      ? { ...layout, cta: { ...layout.cta, y: layout.cta.y + Math.min(W, H) * 0.1, height: layout.cta.height - Math.min(W, H) * 0.1 } }
      : layout;
    const front = frontLayer(`${id}f-`, {
      ...shared, scene, layout: ctaLayout, count, duration: d, domain, hasImage: showImage, textRegion, textAlign,
    });
    push({ op: 'addHtmlElement', clipId: `${id}_front`, name: `Scene ${i + 1} type`, html: front.html, css: front.css, width: W, height: H, start: round(t), duration: d, trackIndex: tracks.front });

    t = round(t + d);
  });

  const duration = round(t);
  if (music?.src) {
    push({ op: 'musicBed', clipId: 'music', src: music.src, volume: 0.32, fadeIn: 0.6, fadeOut: 1.4, duck: false, end: duration });
  }
  return { commands, duration, timeline };
}

/** The first batch: canvas settings plus the layer tracks, bottom to top. */
export function setupCommands(format, background) {
  const f = FORMATS[format] ?? FORMATS.vertical;
  return [
    { op: 'setProjectSettings', aspectRatio: f.aspectRatio, fps: 30, background },
    ...TRACK_ORDER.map((name) => ({ op: 'addTrack', type: 'video', label: name })),
  ];
}
