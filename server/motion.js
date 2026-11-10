// The motion design layer: every scene is authored as two full-canvas HTML
// graphics (one behind the picture, one in front) animated on Vidmoat's
// timeline clock. Inside an HTML element, --vm-t is the clip-relative time in
// seconds and --vm-p is its 0..1 progress, so every move here is a CSS
// expression of time: it scrubs, previews and exports identically.
//
// Rules learned against the live renderer:
// - The stylesheet of an HTML element is global to the frame, so every class is
//   prefixed per clip and bare tag selectors are never used.
// - A catalogue font is only embedded when it is named in a `font-family`
//   declaration (the `font` shorthand is not picked up).
// - No scripts, no external resources, no wall-clock CSS animations.

const num = (n) => String(Math.round(n * 1000) / 1000);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rgba(hex, alpha) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Readable ink on top of a solid colour. */
export const inkOn = (hex) => (luminance(hex) > 0.36 ? '#0d0d0f' : '#ffffff');

// ---------- Easing, as CSS math on the timeline clock ----------

/** Linear 0..1 progress that starts at `at` seconds and lasts `dur`. */
export const prog = (at, dur) => `clamp(0,calc((var(--vm-t) - ${num(at)}) / ${num(dur)}),1)`;
/** Fast start, long settle: the default for anything arriving. */
export const easeOut = (x, power = 4) => `(1 - pow(1 - ${x},${power}))`;
/** Slow start, fast finish: for anything leaving. */
export const easeIn = (x, power = 3) => `pow(${x},${power})`;
/** Overshoots past 1 and settles back. */
export const backOut = (x) => `(1 + 2.70158 * pow(${x} - 1,3) + 1.70158 * pow(${x} - 1,2))`;

// ---------- Art directions ----------

export const LOOKS = {
  punch: {
    headFont: 'Anton', headWeight: 400, uppercase: true, charWidth: 0.4, lineHeight: 1.02, tracking: '0.005em', sizeBoost: 1.22,
    reveal: 'rise', stagger: 0.055, revealTime: 0.5, highlight: 'block', wipe: 'slab', radius: 10,
  },
  sleek: {
    headFont: 'Inter', headWeight: 800, uppercase: false, charWidth: 0.55, lineHeight: 1.04, tracking: '-0.035em', sizeBoost: 1,
    reveal: 'soft', stagger: 0.075, revealTime: 0.75, highlight: 'underline', wipe: 'curtain', radius: 36,
  },
  playful: {
    headFont: 'Titan One', headWeight: 400, uppercase: false, charWidth: 0.6, lineHeight: 1.08, tracking: '0', sizeBoost: 0.92,
    reveal: 'pop', stagger: 0.07, revealTime: 0.6, highlight: 'pill', wipe: 'iris', radius: 48,
  },
};

const BODY = "'Inter',sans-serif";

/** Inclusive word indices of `phrase` inside `text`. */
export function highlightSpan(text, phrase) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = String(text).split(/\s+/).filter(Boolean).map(norm);
  const target = String(phrase ?? '').split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  if (!target.length) return null;
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((t, j) => tokens[i + j] === t)) return { from: i, to: i + target.length - 1 };
  }
  return null;
}

/** Rough height of wrapped text, in pixels. */
export function estimateText(text, sizePx, maxWidthPx, charWidth, lineHeight) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  let lines = 1;
  let lineWidth = 0;
  for (const token of tokens) {
    const w = (token.length + 0.6) * sizePx * charWidth;
    if (lineWidth && lineWidth + w > maxWidthPx) { lines += 1; lineWidth = w; } else lineWidth += w;
  }
  return { lines, height: lines * sizePx * lineHeight };
}

/** The largest size at or under `base` whose wrapped block fits the box. */
export function fitFont(text, base, box, look, maxLines = 4) {
  let size = base * look.sizeBoost;
  const longest = Math.max(...String(text).split(/\s+/).map((w) => w.length), 1);
  // One word must never be wider than the box.
  size = Math.min(size, box.width / ((longest + 0.6) * look.charWidth));
  // Shrink until the block fits the box and reads as a headline, not a column of words.
  for (;;) {
    const est = estimateText(text, size, box.width, look.charWidth, look.lineHeight);
    if (size <= 44 || (est.height <= box.height && est.lines <= maxLines)) break;
    size *= 0.94;
  }
  return Math.round(size);
}

// ---------- Kinetic type ----------

/**
 * A headline whose words arrive one after another, each from behind its own
 * mask, with the emphasis words picked out the way the art direction does it.
 */
function kineticWords(p, text, { at, look, palette, highlight }) {
  const span = highlightSpan(text, highlight);
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const ink = inkOn(palette.accent);
  return tokens.map((word, i) => {
    const x = prog(at + i * look.stagger, look.revealTime);
    const e = easeOut(x);
    let move;
    if (look.reveal === 'rise') move = `transform:translateY(calc((1 - ${e}) * 108%))`;
    else if (look.reveal === 'pop') move = `transform:scale(calc(${backOut(x)})) rotate(calc((1 - ${e}) * -10deg));opacity:${prog(at + i * look.stagger, 0.12)}`;
    else move = `transform:translateY(calc((1 - ${e}) * 64%));opacity:calc(${easeOut(x, 2)});filter:blur(calc((1 - ${e}) * 10px))`;
    const lit = span && i >= span.from && i <= span.to;
    if (!lit) return `<span class="${p}w"><span class="${p}m"><span class="${p}i" style="${move}">${esc(word)}</span></span></span>`;
    // The emphasis lands after its own word has, so the eye sees it happen.
    const sweep = easeOut(prog(at + i * look.stagger + look.revealTime * 0.55, 0.5));
    const colour = look.highlight === 'underline' ? palette.accent : ink;
    return `<span class="${p}w"><span class="${p}h ${p}h-${look.highlight}" style="transform:scaleX(calc(${sweep}))"></span>` +
      `<span class="${p}m"><span class="${p}i" style="${move};color:${colour}">${esc(word)}</span></span></span>`;
  }).join('');
}

function typeCss(p, look, palette) {
  const clip = look.reveal === 'rise' ? 'overflow:hidden;' : '';
  return `
.${p}hd{font-family:'${look.headFont}',sans-serif;font-weight:${look.headWeight};line-height:${look.lineHeight};letter-spacing:${look.tracking};${look.uppercase ? 'text-transform:uppercase;' : ''}color:${palette.text};margin:0}
.${p}w{display:inline-block;position:relative;vertical-align:top;margin:0 0.11em}
.${p}hd{margin-left:-0.11em;margin-right:-0.11em}
.${p}m{display:inline-block;${clip}vertical-align:top;padding:0.06em 0 0.14em;margin:-0.06em 0 -0.14em;position:relative}
.${p}i{display:inline-block;transform-origin:50% 80%}
.${p}h{position:absolute;transform-origin:0 50%;background:${palette.accent}}
.${p}h-block{left:-0.1em;right:-0.1em;top:0.02em;bottom:0.02em}
.${p}h-pill{left:-0.16em;right:-0.16em;top:0;bottom:-0.02em;border-radius:0.32em;rotate:-1.5deg}
.${p}h-underline{left:0;right:0;bottom:-0.02em;height:0.085em;border-radius:0.05em}
.${p}sb{font-family:${BODY};font-weight:500;line-height:1.28;letter-spacing:-0.01em;color:${rgba(palette.text, 0.86)};margin:0}`;
}

/** A supporting line: one soft rise, after the headline has landed. */
const subStyle = (at) => `opacity:${prog(at, 0.5)};transform:translateY(calc((1 - ${easeOut(prog(at, 0.6))}) * 26px))`;

// ---------- Scene furniture ----------

/** Brand lockup and a story-style progress strip, so the piece reads as one film. */
function topBar(p, { brand, index, count, palette, frame }) {
  const segments = Array.from({ length: count }, (_, i) => {
    const fill = i < index ? '1' : i === index ? 'var(--vm-p)' : '0';
    return `<span class="${p}sg"><span class="${p}sf" style="transform:scaleX(${fill})"></span></span>`;
  }).join('');
  const html = `<div class="${p}tb"><div class="${p}sgs">${segments}</div><div class="${p}br">${esc(brand)}</div></div>`;
  const css = `
.${p}tb{position:absolute;left:${frame.margin}px;right:${frame.margin}px;top:${frame.top}px}
.${p}sgs{display:flex;gap:8px}
.${p}sg{flex:1;height:6px;border-radius:3px;background:${rgba(palette.text, 0.22)};overflow:hidden}
.${p}sf{display:block;width:100%;height:100%;background:${palette.text};transform-origin:0 50%}
.${p}br{margin-top:22px;font-family:${BODY};font-weight:700;font-size:${frame.brandSize}px;letter-spacing:0.16em;text-transform:uppercase;color:${rgba(palette.text, 0.9)}}`;
  return { html, css };
}

/**
 * The scene change. The outgoing scene is covered by two panels chasing each
 * other; the incoming scene starts covered and the panels leave. Both halves
 * meet fully closed on the cut, so the cut itself is never seen.
 */
function wipes(p, { look, palette, duration, vertical, enter, exit, reach }) {
  const IN = 0.42;
  const OUT = 0.36;
  const parts = [];
  const axis = vertical ? 'Y' : 'X';
  const second = luminance(palette.background) < 0.4 ? palette.text : palette.surface;
  const panel = (cls, colour, transform) => `<div class="${p}wp ${p}${cls}" style="background:${colour};${transform}"></div>`;
  if (look.wipe === 'iris') {
    // A circle that swallows the frame, then lets go of it.
    if (exit) parts.push(`<div class="${p}ir" style="background:${palette.accent};transform:translate(-50%,-50%) scale(calc(${easeIn(prog(duration - OUT, OUT), 2)} * 2.6))"></div>`);
    if (enter) parts.push(`<div class="${p}ir" style="background:${palette.accent};transform:translate(-50%,-50%) scale(calc((1 - ${easeOut(prog(0, IN + 0.1), 3)}) * 2.6))"></div>`);
  } else {
    const skew = look.wipe === 'slab' ? (vertical ? ' skewY(-7deg)' : ' skewX(-9deg)') : '';
    if (exit) {
      parts.push(panel('a', second, `transform:translate${axis}(calc((1 - ${easeIn(prog(duration - OUT, OUT * 0.86))}) * 135%))${skew}`));
      parts.push(panel('b', palette.accent, `transform:translate${axis}(calc((1 - ${easeIn(prog(duration - OUT + 0.06, OUT - 0.06))}) * 135%))${skew}`));
    }
    if (enter) {
      parts.push(panel('a', second, `transform:translate${axis}(calc(${easeOut(prog(0.08, IN))} * -135%))${skew}`));
      parts.push(panel('b', palette.accent, `transform:translate${axis}(calc(${easeOut(prog(0, IN - 0.06))} * -135%))${skew}`));
    }
  }
  const css = `
.${p}wp{position:absolute;left:-15%;top:-15%;width:130%;height:130%}
.${p}ir{position:absolute;left:50%;top:50%;width:${reach}px;height:${reach}px;border-radius:50%}`;
  return { html: parts.join(''), css, enterTime: enter ? IN : 0 };
}

// ---------- The layer behind the picture ----------

const STAR = 'M50 2 L61 36 L97 36 L68 57 L79 92 L50 71 L21 92 L32 57 L3 36 L39 36Z';

export function backLayer(p, { look, lookName, palette, canvas, index, brand, plate }) {
  const { width: W, height: H } = canvas;
  const flip = index % 2 === 0 ? 1 : -1;
  let decor = '';
  let css = `
.${p}root{position:relative;width:100%;height:100%;overflow:hidden;background:linear-gradient(${150 + (index % 3) * 30}deg,${palette.background} 0%,${palette.background} 38%,${palette.surface} 130%)}`;

  if (lookName === 'punch') {
    // An outlined wall of type drifting behind everything.
    const word = `${esc(brand)} · `.repeat(5);
    const size = Math.round(Math.min(W, H) * 0.34);
    const top = [0.08, 0.6, 0.34][index % 3] * H;
    decor += `<div class="${p}gh" style="top:${Math.round(top)}px;transform:translateX(calc(${flip === 1 ? '-8%' : '-30%'} + var(--vm-t) * ${flip * -46}px))">${word}</div>`;
    decor += `<div class="${p}bar" style="transform:scaleX(calc(${easeOut(prog(0.25, 0.7))}))"></div>`;
    css += `
.${p}gh{position:absolute;left:0;white-space:nowrap;font-family:'Anton',sans-serif;font-size:${size}px;line-height:1;text-transform:uppercase;color:transparent;-webkit-text-stroke:2px ${rgba(palette.text, 0.16)}}
.${p}bar{position:absolute;left:0;bottom:0;width:100%;height:14px;background:${palette.accent};transform-origin:${flip === 1 ? '0' : '100%'} 50%}`;
  } else if (lookName === 'playful') {
    const s = Math.round(Math.min(W, H) * 0.3);
    decor += `<div class="${p}dots"></div>`;
    decor += `<svg class="${p}st" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" style="right:${Math.round(-s * 0.36)}px;top:${Math.round(H * (flip === 1 ? 0.07 : 0.16))}px;transform:rotate(calc(var(--vm-t) * 26deg)) scale(calc(${backOut(prog(0.1, 0.7))}))"><path d="${STAR}" fill="${palette.accent}"/></svg>`;
    decor += `<div class="${p}rg" style="right:${Math.round(-s * 0.42)}px;bottom:${Math.round(H * (flip === 1 ? 0.1 : 0.04))}px;transform:translateY(calc(var(--vm-p) * -70px)) scale(calc(${backOut(prog(0.2, 0.7))}))"></div>`;
    css += `
.${p}dots{position:absolute;inset:0;background-image:radial-gradient(${rgba(palette.text, 0.1)} 3px,transparent 4px);background-size:54px 54px;transform:translate(calc(var(--vm-p) * -27px),calc(var(--vm-p) * -27px))}
.${p}st{position:absolute;width:${s}px;height:${s}px;opacity:0.9}
.${p}rg{position:absolute;width:${s}px;height:${s}px;border-radius:50%;border:${Math.round(s * 0.12)}px solid ${rgba(palette.accent, 0.55)};box-sizing:border-box}`;
  } else {
    // Soft light moving slowly across a fine grid.
    const s = Math.round(Math.max(W, H) * 0.9);
    decor += `<div class="${p}grid"></div>`;
    decor += `<div class="${p}gl" style="${flip === 1 ? 'right' : 'left'}:${Math.round(-s * 0.4)}px;top:${Math.round(-s * 0.35)}px;background:radial-gradient(circle,${rgba(palette.accent, 0.42)} 0%,${rgba(palette.accent, 0)} 62%);transform:translate(calc(var(--vm-p) * ${flip * -110}px),calc(var(--vm-p) * 90px))"></div>`;
    decor += `<div class="${p}gl" style="${flip === 1 ? 'left' : 'right'}:${Math.round(-s * 0.45)}px;bottom:${Math.round(-s * 0.45)}px;background:radial-gradient(circle,${rgba(palette.surface, 0.9)} 0%,${rgba(palette.surface, 0)} 64%);transform:translate(calc(var(--vm-p) * ${flip * 90}px),calc(var(--vm-p) * -70px))"></div>`;
    css += `
.${p}grid{position:absolute;inset:0;background-image:linear-gradient(${rgba(palette.text, 0.055)} 1px,transparent 1px),linear-gradient(90deg,${rgba(palette.text, 0.055)} 1px,transparent 1px);background-size:90px 90px;-webkit-mask-image:radial-gradient(ellipse at 50% 45%,#000 0%,transparent 78%);mask-image:radial-gradient(ellipse at 50% 45%,#000 0%,transparent 78%)}
.${p}gl{position:absolute;width:${s}px;height:${s}px;border-radius:50%}`;
  }

  if (plate) {
    // What the picture sits on: a hard offset block, or a soft shadow.
    const open = easeOut(prog(plate.at, 0.7));
    if (lookName === 'sleek') {
      decor += `<div class="${p}pl" style="left:${plate.x}px;top:${plate.y}px;width:${plate.width}px;height:${plate.height}px;opacity:calc(${open})"></div>`;
      css += `\n.${p}pl{position:absolute;border-radius:${look.radius}px;box-shadow:0 50px 120px ${rgba('#000000', 0.5)},0 0 0 1px ${rgba(palette.text, 0.12)}}`;
    } else {
      const off = lookName === 'punch' ? 20 : 16;
      decor += `<div class="${p}pl" style="left:${plate.x + off * flip}px;top:${plate.y + off}px;width:${plate.width}px;height:${plate.height}px;transform:scale(calc(${open}))"></div>`;
      css += `\n.${p}pl{position:absolute;border-radius:${look.radius}px;background:${palette.accent};transform-origin:50% 50%}`;
    }
  }
  return { html: `<div class="${p}root">${decor}</div>`, css };
}

// ---------- The layer in front of the picture ----------

function box(cls, r, extra = '') {
  return `<div class="${cls}" style="left:${Math.round(r.x)}px;top:${Math.round(r.y)}px;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;${extra}">`;
}

/** Headline plus supporting line inside a region, aligned start, center or end. */
function textRegion(p, scene, region, { look, palette, at, base, subSize, align = 'center', centred = false }) {
  region = { ...region, x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) };
  const subHeight = scene.sub ? estimateText(scene.sub, subSize, region.width, 0.5, 1.28).height + subSize * 0.7 : 0;
  const size = fitFont(scene.headline, base, { width: region.width, height: Math.max(region.height - subHeight, 80) }, look);
  const words = kineticWords(p, scene.headline, { at, look, palette, highlight: scene.highlight });
  const tokens = scene.headline.split(/\s+/).filter(Boolean).length;
  const subAt = at + tokens * look.stagger + look.revealTime * 0.6;
  const justify = { start: 'flex-start', center: 'center', end: 'flex-end' }[align];
  return box(`${p}tx`, region, `justify-content:${justify};${centred ? 'align-items:center;text-align:center;' : ''}`) +
    `<div class="${p}hd" style="font-size:${size}px">${words}</div>` +
    (scene.sub ? `<div class="${p}sb" style="font-size:${subSize}px;margin-top:${Math.round(subSize * 0.7)}px;${subStyle(subAt)}">${esc(scene.sub)}</div>` : '') +
    '</div>';
}

/** A number that rolls into place, digit by digit, like a counter. */
function odometer(p, scene, { at, palette, size }) {
  const digits = Math.round(scene.statValue).toLocaleString('en-US');
  let n = 0;
  const cells = [...digits].map((ch) => {
    if (!/\d/.test(ch)) return `<span class="${p}oc">${ch}</span>`;
    const e = easeOut(prog(at + n * 0.09, 1.1), 5);
    n += 1;
    // Each column is the digits 0-9 stacked; it rolls a full turn and lands on its digit.
    const strip = Array.from({ length: 11 + Number(ch) }, (_, k) => `<span>${k % 10}</span>`).join('');
    return `<span class="${p}od"><span class="${p}os" style="transform:translateY(calc(${e} * -${10 + Number(ch)}em * 1.05))">${strip}</span></span>`;
  }).join('');
  const side = (text, delay) => (text ? `<span class="${p}oc ${p}ox" style="opacity:${prog(at + delay, 0.3)}">${esc(text)}</span>` : '');
  const css = `
.${p}on{display:flex;align-items:flex-start;font-family:'Anton',sans-serif;font-weight:400;font-size:${size}px;line-height:1.05;color:${palette.accent};letter-spacing:0.01em}
.${p}od{display:inline-block;height:1.05em;overflow:hidden}
.${p}os{display:block}
.${p}os span{display:block;height:1.05em}
.${p}oc{display:inline-block;height:1.05em}
.${p}ox{color:${palette.text}}`;
  return { html: `<div class="${p}on">${side(scene.statPrefix, 0.1)}${cells}${side(scene.statSuffix, 0.9)}</div>`, css };
}

/**
 * The foreground of one scene.
 * @returns {{html:string, css:string}}
 */
export function frontLayer(p, ctx) {
  const { scene, look, lookName, palette, canvas, layout, index, count, brand, duration, domain, hasImage } = ctx;
  const overMedia = Boolean(ctx.overMedia);
  const { width: W, height: H } = canvas;
  const vertical = W <= H;
  const wipe = wipes(p, { look, palette: ctx.wipePalette ?? palette, duration, vertical, enter: index > 0, exit: index < count - 1, reach: Math.max(W, H) });
  const at = wipe.enterTime + 0.08; // type starts as the panels clear
  const bar = topBar(p, { brand, index, count, palette, frame: layout.frame });
  let body = '';
  let css = `
.${p}root{position:relative;width:100%;height:100%;overflow:hidden}
.${p}tx{position:absolute;display:flex;flex-direction:column}` + typeCss(p, look, palette) + bar.css + wipe.css;
  const common = { look, palette, at, subSize: layout.subSize };

  if (scene.kind === 'hook' || overMedia) {
    if (hasImage || overMedia) {
      // A scrim that is heaviest where the words sit.
      body += `<div class="${p}scrim"></div>`;
      css += `\n.${p}scrim{position:absolute;inset:0;background:linear-gradient(${vertical ? '180deg' : '270deg'},${rgba(palette.background, 0.62)} 0%,${rgba(palette.background, 0.78)} 45%,${rgba(palette.background, 0.96)} 100%)}`;
    }
    body += textRegion(p, scene, layout.hook, { ...common, base: scene.kind === 'hook' ? layout.heroSize : layout.soloSize, align: (hasImage || overMedia) && vertical ? 'end' : 'center' });
  } else if (scene.kind === 'stat') {
    const r = layout.stat;
    const odo = odometer(p, scene, { at: at + 0.1, palette, size: fitFont(Math.round(scene.statValue).toLocaleString('en-US') + scene.statPrefix + scene.statSuffix, layout.statSize, { width: r.width, height: 9999 }, { ...LOOKS.punch, sizeBoost: 1, charWidth: 0.5 }) });
    const rule = easeOut(prog(at + 0.7, 0.6));
    body += box(`${p}tx`, r, 'justify-content:center;') + odo.html +
      `<div class="${p}rule" style="transform:scaleX(calc(${rule}))"></div>` +
      `<div class="${p}hd" style="font-size:${fitFont(scene.headline, layout.headSize * 0.82, { width: r.width, height: 320 }, look)}px;margin-top:${Math.round(layout.subSize * 0.8)}px">${kineticWords(p, scene.headline, { at: at + 0.75, look, palette, highlight: scene.highlight })}</div>` +
      (scene.sub ? `<div class="${p}sb" style="font-size:${layout.subSize}px;margin-top:${Math.round(layout.subSize * 0.6)}px;${subStyle(at + 1.3)}">${esc(scene.sub)}</div>` : '') +
      '</div>';
    css += odo.css + `\n.${p}rule{height:8px;width:${Math.round(r.width * 0.42)}px;background:${palette.text};transform-origin:0 50%;margin-top:${Math.round(layout.subSize * 0.5)}px;border-radius:4px}`;
  } else if (scene.kind === 'cta') {
    const r = layout.cta;
    const ink = inkOn(palette.accent);
    const label = scene.cta || 'Learn more';
    const tokens = scene.headline.split(/\s+/).filter(Boolean).length;
    const btnAt = at + tokens * look.stagger + look.revealTime * 0.7;
    const pop = backOut(prog(btnAt, 0.6));
    // After it lands the button breathes twice, and a band of light crosses it.
    const pulse = (start) => `${easeOut(prog(start, 0.28), 2)} * (1 - ${easeOut(prog(start + 0.28, 0.4), 2)})`;
    const shine = prog(btnAt + 0.75, 0.9);
    body += box(`${p}tx`, r, 'justify-content:center;align-items:center;text-align:center;') +
      `<div class="${p}hd" style="font-size:${fitFont(scene.headline, layout.ctaSize, { width: r.width, height: r.height * 0.42 }, look)}px">${kineticWords(p, scene.headline, { at, look, palette, highlight: scene.highlight })}</div>` +
      `<div class="${p}btn" style="transform:scale(calc(${pop} * (1 + 0.06 * (${pulse(btnAt + 1.1)}) + 0.06 * (${pulse(btnAt + 2)}))));opacity:${prog(btnAt, 0.15)}">` +
      `<span class="${p}bl">${esc(label)}</span><span class="${p}ba" style="transform:translateX(calc(${easeOut(prog(btnAt + 0.5, 0.5))} * 10px))">&rarr;</span>` +
      `<span class="${p}sh" style="transform:translateX(calc(${shine} * 520% - 160%)) skewX(-20deg)"></span></div>` +
      (domain ? `<div class="${p}url" style="${subStyle(btnAt + 0.45)}">${esc(domain)}</div>` : '') +
      '</div>';
    css += `
.${p}btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:0.4em;margin-top:${Math.round(layout.subSize * 1.5)}px;padding:0.62em 1.15em;border-radius:999px;background:${palette.accent};color:${ink};font-family:${BODY};font-weight:800;font-size:${layout.buttonSize}px;letter-spacing:-0.02em;white-space:nowrap}
.${p}ba{display:inline-block;font-weight:600}
.${p}sh{position:absolute;left:0;top:0;width:30%;height:100%;background:linear-gradient(90deg,${rgba('#ffffff', 0)},${rgba('#ffffff', 0.5)},${rgba('#ffffff', 0)})}
.${p}url{margin-top:${Math.round(layout.subSize * 0.9)}px;font-family:${BODY};font-weight:600;font-size:${Math.round(layout.subSize * 0.86)}px;letter-spacing:0.04em;color:${rgba(palette.text, 0.8)}}`;
  } else if (hasImage) {
    body += textRegion(p, scene, ctx.textRegion, { ...common, base: layout.headSize, align: ctx.textAlign });
  } else {
    // Type-only scenes take turns between four compositions so no two in a row look alike.
    const variant = (ctx.soloVariant ?? 0) % 4;
    const r = layout.solo;
    if (variant === 1) {
      // A giant outlined scene number above a headline that sits low in the frame.
      const numSize = Math.round(Math.min(W, H) * 0.42);
      const rise = easeOut(prog(at, 0.9));
      body += `<div class="${p}ix" style="left:${r.x}px;top:${Math.round(r.y - numSize * 0.08)}px;font-size:${numSize}px;transform:translateY(calc((1 - ${rise}) * 60px));opacity:calc(${rise})">${String(index).padStart(2, '0')}</div>`;
      css += `\n.${p}ix{position:absolute;font-family:'Anton',sans-serif;font-weight:400;line-height:1;color:transparent;-webkit-text-stroke:3px ${palette.accent}}`;
      body += textRegion(p, scene, { ...r, y: r.y + r.height * 0.4, height: r.height * 0.6 }, { ...common, at: at + 0.15, base: layout.soloSize * 0.86, align: 'end' });
    } else if (variant === 2) {
      // Everything centred, the supporting line in a pill.
      body += textRegion(p, { ...scene, sub: '' }, { ...r, height: r.height * 0.62 }, { ...common, base: layout.soloSize, align: 'end', centred: true });
      if (scene.sub) {
        const pillAt = at + 0.7;
        body += box(`${p}tx`, { ...r, y: r.y + r.height * 0.62 + 44, height: r.height * 0.3 }, 'align-items:center;') +
          `<div class="${p}pill" style="transform:scale(calc(${backOut(prog(pillAt, 0.55))}));opacity:${prog(pillAt, 0.15)}">${esc(scene.sub)}</div></div>`;
        css += `\n.${p}pill{font-family:${BODY};font-weight:600;font-size:${Math.round(layout.subSize * 0.92)}px;line-height:1.25;text-align:center;color:${inkOn(palette.accent)};background:${palette.accent};padding:0.5em 1em;border-radius:1.4em;max-width:92%}`;
      }
    } else if (variant === 3) {
      // A thick rule draws across, and the headline hangs from it at the bottom.
      const rule = easeOut(prog(at, 0.8));
      const y = r.y + r.height * 0.46;
      body += `<div class="${p}rl" style="left:${r.x}px;top:${Math.round(y)}px;width:${r.width}px;transform:scaleX(calc(${rule}))"></div>`;
      css += `\n.${p}rl{position:absolute;height:10px;background:${palette.accent};transform-origin:0 50%;border-radius:5px}`;
      body += textRegion(p, scene, { ...r, y: y + 54, height: r.y + r.height - y - 54 }, { ...common, at: at + 0.2, base: layout.soloSize * 0.9, align: 'start' });
    } else {
      body += textRegion(p, scene, r, { ...common, base: layout.soloSize, align: 'center' });
    }
  }

  return { html: `<div class="${p}root">${body}${bar.html}${wipe.html}</div>`, css, typeAt: at };
}
