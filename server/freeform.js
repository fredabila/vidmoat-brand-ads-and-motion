// Scenes Claude designs itself. In a `custom` scene Claude is not filling a
// template: it writes the HTML and CSS of the motion graphic, animated on the
// timeline clock, and this file is the gate between what it wrote and what is
// put on the timeline.
//
// The gate matters because the markup ends up inside Vidmoat's renderer and
// player, and because a stylesheet there is global to the frame. So the design
// is rebuilt from an allowlist (tags, attributes, selectors), every class is
// forced into a namespace, and anything that could load, run or escape is dropped.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import * as cheerio from 'cheerio';

/** The class prefix Claude writes with; compose swaps it for the clip's own. */
export const NS = 'sc-';
const MAX_HTML = 14_000;
const MAX_CSS = 14_000;

const TAGS = new Set(['div', 'span', 'p', 'b', 'i', 'em', 'strong', 'br', 'ul', 'ol', 'li',
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRS = new Set(['class', 'style', 'xmlns', 'viewbox', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'pathlength', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'preserveaspectratio']);

// Anything that fetches, runs, escapes the frame or animates on the wall clock.
const BAD_VALUE = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|position\s*:\s*fixed|(^|[;{\s])(animation|transition)[\w-]*\s*:|<|\\/i;

function cleanStyle(value) {
  const style = String(value ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  return BAD_VALUE.test(style) ? null : style.trim();
}

function cleanHtml(html) {
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);
  let ok = true;
  $('#root').find('*').each((_, el) => {
    // Script and style elements have their own node types, so test for a name, not for type 'tag'.
    if (!el.name) return;
    if (!TAGS.has(el.name.toLowerCase())) { ok = false; return; }
    for (const [name, value] of Object.entries(el.attribs)) {
      const key = name.toLowerCase();
      if (!ATTRS.has(key)) { $(el).removeAttr(name); continue; }
      if (key === 'class') {
        // Only namespaced classes survive, so no rule can ever reach another clip.
        const kept = String(value).split(/\s+/).filter((c) => /^sc-[\w-]+$/.test(c));
        if (kept.length) $(el).attr(name, kept.join(' ')); else $(el).removeAttr(name);
      } else if (key === 'style') {
        const style = cleanStyle(value);
        if (style === null) ok = false; else $(el).attr(name, style);
      } else if (/url\s*\(|javascript:|[<>]/i.test(String(value))) {
        $(el).removeAttr(name);
      }
    }
  });
  // Inline SVG renders as nothing without its namespace.
  $('#root').find('svg').each((_, el) => { if (!$(el).attr('xmlns')) $(el).attr('xmlns', 'http://www.w3.org/2000/svg'); });
  return ok ? $('#root').html() : null;
}

const SIMPLE = String.raw`\.sc-[\w-]+(?:\.sc-[\w-]+)*(?:::?[a-z-]+(?:\([\w\s+-]*\))?)*`;
const SELECTOR = new RegExp(`^${SIMPLE}(?:\\s*[>+~]?\\s*${SIMPLE})*$`, 'i');

/** Returns the cleaned stylesheet, or { error } naming the first thing that is not allowed. */
function cleanCss(css) {
  const text = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const no = (error) => ({ error });
  if (/@/.test(text)) return no('@ rules (such as @keyframes or @media) are not allowed'); // also @import, @font-face
  const out = [];
  for (const block of text.split('}')) {
    if (!block.trim()) continue;
    const brace = block.indexOf('{');
    if (brace < 0) return no('unbalanced braces');
    const selectors = block.slice(0, brace).split(',').map((sel) => sel.trim());
    const body = block.slice(brace + 1).trim();
    const badSelector = selectors.find((sel) => !SELECTOR.test(sel));
    if (badSelector !== undefined) return no(`selector "${badSelector.slice(0, 80)}" is not made only of sc- classes`);
    if (body.includes('{')) return no('nested rules are not allowed');
    if (BAD_VALUE.test(`;${body}`)) return no(`a declaration in "${selectors[0].slice(0, 60)}" uses url(), animation, transition, position:fixed or a backslash`);
    out.push(`${selectors.join(',')}{${body}}`);
  }
  return { css: out.join('\n') };
}

/** Returns a safe {html, css} written in the `sc-` namespace, or null when the design cannot be trusted. */
export function sanitizeDesign(design) {
  return checkDesign(design).design;
}

/** Like sanitizeDesign, but says why a design was refused. */
export function checkDesign(design) {
  const no = (reason) => ({ design: null, reason });
  if (!design || typeof design.html !== 'string' || typeof design.css !== 'string') return no('no markup');
  if (!design.html.trim()) return no('empty markup');
  if (design.html.length > MAX_HTML || design.css.length > MAX_CSS) return no(`too long (${design.html.length} + ${design.css.length} characters)`);
  const html = cleanHtml(design.html);
  if (html === null) return no('markup uses an element or inline style that is not allowed');
  const sheet = cleanCss(design.css);
  if (sheet.error) return no(`stylesheet: ${sheet.error}`);
  const { css } = sheet;
  if (!html.includes('class="sc-')) return no('classes are not in the sc- namespace');
  // The design has to be driven by the timeline, or it is a still.
  if (!/--vm-[tp]/.test(html + css)) return no('nothing moves on the timeline clock');
  // The frame background: one declaration value, nothing that could close the rule or fetch.
  const bg = typeof design.background === 'string' ? design.background.trim() : '';
  const background = bg && bg.length <= 800 && !/[;{}]/.test(bg) && !BAD_VALUE.test(bg) ? bg : '';
  const m = design.mediaBox;
  const box = m && [m.x, m.y, m.width, m.height].every(Number.isFinite) && m.width >= 120 && m.height >= 120 && m.x >= 0 && m.y >= 0 && m.x + m.width <= 4000 && m.y + m.height <= 4000
    ? { x: Math.round(m.x), y: Math.round(m.y), width: Math.round(m.width), height: Math.round(m.height) } : null;
  return { design: { html, css, background, mediaBox: box }, reason: null };
}

/** Move a sanitised design into a clip's own namespace. */
export function scopeDesign(design, prefix) {
  return {
    ...design,
    html: design.html.replace(/\bsc-/g, prefix),
    css: design.css.replace(/\.sc-/g, `.${prefix}`),
  };
}

// ---------- Asking Claude for the design ----------

const DesignSchema = z.object({
  html: z.string().describe('Body markup for the scene. One root element.'),
  css: z.string().describe('The stylesheet. Class selectors only.'),
  background: z.string().describe('Only when you own the whole frame: one CSS background value for the frame (a colour, or gradients, built from the palette variables). Empty string otherwise.'),
  mediaBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .describe('Only when you own the whole frame and the scene has a picture: where it goes, in pixels from the top-left. All zeros otherwise.'),
});

const SYSTEM = `You are a motion designer. You are given one scene of a short ad and you design it from scratch as an HTML and CSS motion graphic. Nobody will edit your output: it is rendered to video exactly as written, so it has to be right on its own.

How the renderer works:
- Your markup is drawn at exactly the canvas size, in Chromium. There is no script, no network and no wall clock.
- Time is a CSS variable. --vm-t is the number of seconds since the scene started and --vm-p goes from 0 to 1 across the scene. Every movement is a CSS expression of one of them, written inline in a style attribute or in the stylesheet. CSS animations, transitions and @keyframes do not run and are rejected.
- Progress of a move that starts at S seconds and lasts D: clamp(0,calc((var(--vm-t) - S) / D),1). Call that X.
- Ease out (use for everything arriving): (1 - pow(1 - X,4)). Overshoot: (1 + 2.70158 * pow(X - 1,3) + 1.70158 * pow(X - 1,2)). Linear moves read as robotic.
- Typical uses: transform:translateY(calc((1 - E) * 60px)) to rise in, opacity:X to fade, transform:scaleX(calc(E)) with transform-origin for a bar or rule that draws, clip-path:inset(0 calc((1 - E) * 100%) 0 0) to wipe something open, stroke-dashoffset on an SVG path with pathLength="1" to draw a line.
- The scene is cut to by a wipe that covers the frame for the first 0.45 seconds, so start your first move at 0.45 or later, stagger the rest by 0.08 to 0.3 seconds, and have everything on screen by 2.2 seconds. The scene then holds; give it life with one slow continuous move driven by --vm-p (a 2 to 4 percent scale or a small drift), never by anything fast.

Rules the gate enforces (a design that breaks one is thrown away and replaced by a plain template):
- Every class starts with "sc-". Selectors are class selectors only: no tag, id, attribute or universal selectors, no @ rules.
- Allowed elements: div, span, p, b, i, em, strong, br, ul, ol, li, and inline svg with g, path, circle, ellipse, rect, line, polyline, polygon. No img, no text inside svg, no style or script tags.
- No url(), no external anything, no position:fixed.

Design rules:
{{FRAME}}
- Use the palette only through these variables, so the scene can be recoloured: var(--bg), var(--surface), var(--accent), var(--text), and var(--on-accent) for anything sitting on the accent colour.
- Anything sitting on var(--accent) is coloured var(--on-accent). Never set var(--accent) against var(--text), in either direction: on some scenes they are close.
- Use exactly the two font-family values you are given, written out literally.
- Position with absolute pixel boxes or flexbox inside the safe box. Text must never overflow: size type for the longest line, allow wrapping, and leave margins. Body text is never smaller than 34px on a 1080-wide canvas; headlines are large.
- Viewers have the sound off and about four seconds. One idea, a clear hierarchy, and a reveal with an order to it: the thing that matters most lands last or biggest.
- Use only the words and facts in the scene you are given. Do not add claims, numbers, names or prices.
- This is where the video stops looking like a template, so do not make a centred headline with a line under it. Build the thing the brief describes: a comparison, steps, a mock screen, a chart, a price tag, a chat, a rating, a timeline, type as image.`;

const FRAME_SHARED = `- One root element with class sc-root, position:absolute, covering the canvas (left:0;top:0;width:100%;height:100%), transparent. A themed background is already drawn behind you, and a brand bar is drawn on top in the top band, so keep everything inside the safe box you are given. Return an empty background and a zero mediaBox.`;

const FRAME_OWNED = `- One root element with class sc-root, position:absolute, covering the canvas (left:0;top:0;width:100%;height:100%), transparent. You own the whole frame: nothing is drawn that you did not ask for. There is no template, no brand bar, no stock background.
- Return the frame's background in "background": one CSS background value built from the palette variables (a flat colour, layered gradients, a pattern made of gradients). It is painted behind your layer and behind any picture. Moving background shapes belong in your markup, not there.
- If the scene has a picture, it is placed for you behind your layer, cropped to fill the box you return in mediaBox. Leave that box clear, or frame it, label it, overlap its edge with type: design around it. If you would rather not show the picture, return zeros. If the scene has footage, it fills the whole frame behind you: put your own scrim under the words.
- You are one of several designers drawing scenes of the same film at the same moment. Follow the film's design system exactly (its fonts, its motif, its way of moving) so the scenes belong together, and give your scene a composition its neighbours do not have.
- If the brand name should appear, you place it. Keep all text inside the safe box.`;

const system = (owned) => SYSTEM.replace('{{FRAME}}', owned ? FRAME_OWNED : FRAME_SHARED);

function ownedPrompt({ scene, canvas, safe, palette, direction, brand, index, count, neighbours, media }) {
  return `Canvas: ${canvas.width} x ${canvas.height} pixels. Safe box for text: left ${safe.x}, top ${safe.y}, width ${safe.width}, height ${safe.height}.

The film's design system (set by the art director, the same for every scene):
- Concept: ${direction.concept}
- Motif: ${direction.motif}
- Headline font-family: '${direction.headFont}',sans-serif
- Body font-family: '${direction.bodyFont}',sans-serif
- Palette (use the variables; these values are for judging contrast): --bg ${palette.background}, --surface ${palette.surface}, --accent ${palette.accent}, --text ${palette.text}
- Scene changes: ${direction.transition === 'cut' ? 'hard cuts, so your first move may start at 0.1 seconds' : `a ${direction.transition} wipe covers the frame for the first 0.45 seconds`}
- Brand: ${brand}

Your scene is number ${index + 1} of ${count} (${scene.kind}).
- What to build: ${scene.brief || scene.headline}
- Headline: ${scene.headline}
- Supporting line: ${scene.sub || '(none)'}
- Points: ${(scene.items ?? []).join(' | ') || '(none)'}
${scene.kind === 'stat' ? `- The number: ${scene.statPrefix}${scene.statValue}${scene.statSuffix}\n` : ''}${scene.kind === 'cta' ? `- Button label: ${scene.cta}\n` : ''}- The narrator says over it: ${scene.voice || '(nothing)'}
- Picture: ${media ?? 'none'}

For continuity, the scene before yours: ${neighbours.before ?? '(yours is first)'}
The scene after yours: ${neighbours.after ?? '(yours is last)'}`;
}

function userPrompt({ scene, canvas, safe, palette, look, brand }) {
  return `Canvas: ${canvas.width} x ${canvas.height} pixels.
Safe box (keep everything inside it): left ${safe.x}, top ${safe.y}, width ${safe.width}, height ${safe.height}.
Headline font-family: '${look.headFont}',sans-serif (weight ${look.headWeight}${look.uppercase ? ', set in capitals' : ''}).
Body font-family: 'Inter',sans-serif (weights 400 to 800).
Art direction: ${look.mood}
Palette right now (use the variables, these are for judging contrast): background ${palette.background}, surface ${palette.surface}, accent ${palette.accent}, text ${palette.text}.
Brand: ${brand}

The scene:
- What to build: ${scene.brief}
- Headline: ${scene.headline}
- Supporting line: ${scene.sub || '(none)'}
- Points: ${(scene.items ?? []).join(' | ') || '(none)'}
- The narrator says over it: ${scene.voice || '(nothing)'}`;
}

/**
 * Ask Claude to design one scene. Returns { design, reason }: a sanitised design, or
 * null with why (the caller then falls back to a template scene). Never throws.
 */
export async function designScene(client, ctx, { model, log = () => {} } = {}) {
  try {
    const owned = Boolean(ctx.direction);
    const content = [{ type: 'text', text: owned ? ownedPrompt(ctx) : userPrompt(ctx) }];
    // In an owned frame the designer sees the picture it is composing around.
    if (owned && ctx.picture) content.push({ type: 'image', source: { type: 'url', url: ctx.picture } });
    const messages = [{ role: 'user', content }];
    let checked = { design: null, reason: 'no attempt' };
    // One correction round: if the gate refuses the design, Claude is told exactly why and fixes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await client.beta.messages.parse({
        model: model ?? process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: system(owned),
        messages,
        output_config: { effort: 'medium', format: betaZodOutputFormat(DesignSchema) },
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return { design: null, reason: `Claude stopped with ${response.stop_reason}` };
      checked = checkDesign(response.parsed_output);
      if (checked.design) return checked;
      log(`custom scene "${ctx.scene.headline}" (attempt ${attempt + 1}): ${checked.reason}`);
      // The assistant turn goes back exactly as it came, thinking blocks included.
      messages.push({ role: 'assistant', content: response.content },
        { role: 'user', content: `The gate refused that design: ${checked.reason}. Send the whole design again with that fixed and everything else kept.` });
    }
    return checked;
  } catch (err) {
    log(err instanceof Anthropic.APIError ? `custom scene: ${err.message}` : err);
    // A picture the API cannot read must not cost the scene its design: try once more without it.
    if (err instanceof Anthropic.BadRequestError && ctx.picture) return designScene(client, { ...ctx, picture: null }, { model, log });
    return { design: null, reason: err instanceof Anthropic.APIError ? `Claude API error ${err.status ?? ''}: ${String(err.message).slice(0, 160)}`.trim() : 'unexpected error' };
  }
}
