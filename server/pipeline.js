// Link -> finished Vidmoat project. Each stage reports progress through `emit`
// so the page can show what is happening while it waits.

import { imageSize } from 'image-size';
import { readLink } from './scrape.js';
import { writeStoryboard, sanitizeStoryboard, LENGTHS } from './creative.js';
import { compose, setupCommands, FORMATS, STYLES, TRACK_ORDER } from './compose.js';

const MEDIA_PREFIX = 'https://api.vidmoat.com/uploads/';
const MAX_IMAGES = 6;
const BATCH = 150; // the API takes at most 200 commands per request

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i).catch(() => null);
    }
  }));
  return out;
}

/** Import one picture into the Vidmoat library and measure it. Null when it is not usable. */
async function importImage(vidmoat, url, { fetchImpl = fetch, minWidth = 320, minHeight = 200 } = {}) {
  const { media } = await vidmoat.importMedia(url);
  if (media?.mediaType !== 'image' || !media.url) return null;
  const res = await fetchImpl(media.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const { width, height } = imageSize(new Uint8Array(await res.arrayBuffer()));
  if (!width || !height || width < minWidth || height < minHeight) return null;
  const ratio = width / height;
  if (ratio > 3.4 || ratio < 0.3) return null; // banners and slivers make bad cards
  return { src: media.url, width, height };
}

async function importAssets(brief, vidmoat, deps) {
  const candidates = brief.images.slice(0, MAX_IMAGES + 3);
  const [imported, logo] = await Promise.all([
    mapLimit(candidates, 4, (img) => importImage(vidmoat, img.url, deps)),
    brief.logo ? importImage(vidmoat, brief.logo, { ...deps, minWidth: 96, minHeight: 96 }).catch(() => null) : null,
  ]);
  const images = [];
  candidates.forEach((img, i) => {
    if (imported[i] && images.length < MAX_IMAGES) images.push({ ...imported[i], alt: img.alt, hint: img.hint });
  });
  // A logo wider than 2:1 is a wordmark on a transparent strip; the brand name in type reads better.
  const squareLogo = logo && logo.width / logo.height < 2 && logo.height / logo.width < 2 ? logo : null;
  return { images, logo: squareLogo };
}

async function findMusic(vidmoat, query, videoSeconds) {
  const { data = [] } = await vidmoat.searchStock(`${query} music`, 'audio', 12);
  // Short results are sound effects, not a bed.
  const beds = data.filter((r) => r.downloadUrl && r.duration >= 25 && r.duration <= 420);
  const pick = beds.find((r) => r.duration >= videoSeconds) ?? beds[0];
  if (!pick) return null;
  const { media } = await vidmoat.importMedia(pick.downloadUrl);
  if (media?.mediaType !== 'audio') return null;
  return { src: media.url, name: pick.name ?? 'Stock music', credit: pick.username ?? null, sourceUrl: pick.sourceUrl ?? null };
}

function failures(results) {
  return (results ?? []).filter((r) => r && r.ok === false).map((r) => `${r.op}: ${r.error ?? 'failed'}`);
}

async function applyAll(vidmoat, projectId, commands) {
  const problems = [];
  let lint = [];
  for (let i = 0; i < commands.length; i += BATCH) {
    const res = await vidmoat.applyCommands(projectId, commands.slice(i, i + BATCH));
    problems.push(...failures(res.results), ...(res.blocked ?? []).map((b) => `${b.op ?? b}: not included in the plan`));
    lint = res.lint ?? lint;
  }
  return { problems, lint };
}

function tracksFromDocument(document) {
  const tracks = {};
  for (const track of document.tracks ?? []) if (TRACK_ORDER.includes(track.label)) tracks[track.label] = track.id;
  const missing = TRACK_ORDER.filter((name) => tracks[name] === undefined);
  if (missing.length) throw new Error(`This project was not made here (missing tracks: ${missing.join(', ')})`);
  return tracks;
}

function describe({ projectId, storyboard, assets, music, composed, document, lint, problems, format, style, source, reason, brief }) {
  return {
    projectId,
    format,
    style,
    duration: composed.duration,
    timeline: composed.timeline,
    storyboard,
    assets,
    music,
    document,
    lint: (lint ?? []).filter((l) => l.severity === 'warn').map((l) => ({ time: l.time, message: l.message })),
    problems,
    writer: source ? { source, reason: reason ?? null } : undefined,
    page: brief ? { url: brief.url, domain: brief.domain, title: brief.title } : undefined,
  };
}

export async function buildVideo(input, { vidmoat, emit = () => {}, anthropic, fetchImpl, log = () => {} }) {
  const format = FORMATS[input.format] ? input.format : 'vertical';
  const style = STYLES[input.style] ? input.style : 'sleek';
  const length = LENGTHS[input.length] ? input.length : 'standard';

  emit('read', 'active');
  const brief = await readLink(input.url, fetchImpl ? { fetchImpl } : undefined);
  emit('read', 'done', brief.title || brief.domain);

  emit('media', 'active');
  const assets = await importAssets(brief, vidmoat, fetchImpl ? { fetchImpl } : undefined);
  // From here on, image numbers mean "usable, imported pictures".
  brief.images = assets.images.map((img) => ({ alt: img.alt, hint: img.hint, width: img.width, height: img.height }));
  emit('media', 'done', `${assets.images.length} image${assets.images.length === 1 ? '' : 's'}`);

  emit('write', 'active');
  const { storyboard, source, reason } = await writeStoryboard(brief, {
    goal: input.goal, length, format: FORMATS[format].label, client: anthropic, log,
  });
  emit('write', 'done', source === 'claude' ? `${storyboard.scenes.length} scenes` : 'Written from the page text');

  emit('build', 'active');
  const [created, music] = await Promise.all([
    vidmoat.createProject(`LinkReel · ${storyboard.brandName} · ${FORMATS[format].aspectRatio}`, setupCommands(format, storyboard.palette.background)),
    input.music === false ? null : findMusic(vidmoat, storyboard.musicQuery, 30).catch((err) => { log(`music: ${err.message}`); return null; }),
  ]);
  const projectId = created.project.id;
  const trackIds = (created.results ?? []).filter((r) => r.op === 'addTrack' && r.ok).map((r) => r.data?.trackId);
  if (trackIds.length !== TRACK_ORDER.length || trackIds.some((id) => typeof id !== 'number')) {
    throw new Error('Vidmoat did not create the layer tracks');
  }
  const tracks = Object.fromEntries(TRACK_ORDER.map((name, i) => [name, trackIds[i]]));
  const canvas = { width: created.project.settings.width, height: created.project.settings.height };

  const composed = compose({ storyboard, images: assets.images, logo: assets.logo, canvas, format, style, tracks, music, domain: brief.domain });
  const { problems, lint } = await applyAll(vidmoat, projectId, composed.commands);
  const document = await vidmoat.getDocument(projectId);
  emit('build', 'done', `${composed.duration.toFixed(1)}s`);

  return describe({ projectId, storyboard, assets, music, composed, document, lint, problems, format, style, source, reason, brief });
}

function checkAsset(asset) {
  return asset && typeof asset.src === 'string' && asset.src.startsWith(MEDIA_PREFIX) &&
    Number.isFinite(asset.width) && Number.isFinite(asset.height) && asset.width > 0 && asset.height > 0;
}

/** Re-lay an existing project from an edited storyboard. Nothing is re-imported or re-written by the model. */
export async function rebuildVideo(input, { vidmoat }) {
  const format = FORMATS[input.format] ? input.format : 'vertical';
  const style = STYLES[input.style] ? input.style : 'sleek';
  // Media can only be files already in the Vidmoat library, never an arbitrary URL.
  const images = (Array.isArray(input.assets?.images) ? input.assets.images : []).slice(0, MAX_IMAGES).filter(checkAsset)
    .map(({ src, width, height, alt, hint }) => ({ src, width, height, alt: String(alt ?? ''), hint: String(hint ?? '') }));
  const logo = checkAsset(input.assets?.logo) ? { src: input.assets.logo.src, width: input.assets.logo.width, height: input.assets.logo.height } : null;
  const music = typeof input.music?.src === 'string' && input.music.src.startsWith(MEDIA_PREFIX) ? input.music : null;

  const sceneCount = Math.min(Math.max(input.storyboard?.scenes?.length ?? 0, 2), 10);
  const storyboard = sanitizeStoryboard(input.storyboard, { images, siteName: 'Brand', title: '', domain: '' }, { sceneCount, trustNumbers: true });

  const before = await vidmoat.getDocument(input.projectId);
  const tracks = tracksFromDocument(before);
  const canvas = { width: before.settings.width, height: before.settings.height };
  const domain = String(input.domain ?? '').replace(/[^a-z0-9.-]/gi, '').slice(0, 80);
  const composed = compose({ storyboard, images, logo, canvas, format, style, tracks, music, domain });
  const { problems, lint } = await applyAll(vidmoat, input.projectId, [
    { op: 'clearTimeline' },
    { op: 'setProjectSettings', background: storyboard.palette.background },
    ...composed.commands,
  ]);
  const document = await vidmoat.getDocument(input.projectId);
  return describe({ projectId: input.projectId, storyboard, assets: { images, logo }, music, composed, document, lint, problems, format, style });
}
