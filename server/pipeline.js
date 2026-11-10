// Link -> finished Vidmoat project. Each stage reports progress through `emit`
// so the page can show what is happening while it waits.

import { imageSize } from 'image-size';
import { parseBuffer } from 'music-metadata';
import { readLink } from './scrape.js';
import { writeStoryboard, sanitizeStoryboard, LENGTHS } from './creative.js';
import { compose, setupCommands, sceneDuration, FORMATS, STYLES, TRACK_ORDER } from './compose.js';

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
  return { src: media.url, width, height, contentType: media.contentType ?? '' };
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

/** Stock footage for one scene, in the canvas's orientation. Null when nothing suitable is found. */
async function findFootage(vidmoat, query, format, seconds) {
  const { data = [] } = await vidmoat.searchStock(query, 'video', 10);
  const fits = (r) => r.downloadUrl && r.width && r.height && (r.duration ?? 0) >= seconds;
  const oriented = (r) => (format === 'vertical' ? r.height > r.width : format === 'wide' ? r.width > r.height : true);
  const pick = data.find((r) => fits(r) && oriented(r)) ?? data.find(fits);
  if (!pick) return null;
  const { media } = await vidmoat.importMedia(pick.downloadUrl);
  if (media?.mediaType !== 'video') return null;
  return { src: media.url, width: pick.width, height: pick.height, duration: media.durationSec ?? pick.duration, credit: pick.photographer ?? null };
}

const MAX_FOOTAGE = 3;

export const VOICES = {
  marin: 'Marin · warm', cedar: 'Cedar · steady', nova: 'Nova · bright', onyx: 'Onyx · deep', coral: 'Coral · friendly', ash: 'Ash · crisp',
};
const DELIVERY = 'An advert narrator: confident, warm and clear, at a natural pace. No sing-song.';

/**
 * Speak each scene's line. `existing` lets a rebuild keep every line whose words
 * did not change, so editing one scene pays for one line, not all of them.
 * Returns an array aligned with the scenes; null where a scene has no narration.
 */
async function recordVoices(vidmoat, storyboard, voiceId, { existing = [], fetchImpl = fetch, log = () => {} } = {}) {
  return Promise.all(storyboard.scenes.map(async (scene) => {
    if (!scene.voice) return null;
    const kept = existing.find((v) => v && v.text === scene.voice && v.voiceId === voiceId);
    if (kept) return kept;
    try {
      const out = await vidmoat.createSpeech(scene.voice, { voiceId, instructions: DELIVERY });
      const res = await fetchImpl(out.url, { signal: AbortSignal.timeout(30_000) });
      const meta = await parseBuffer(new Uint8Array(await res.arrayBuffer())).catch(() => null);
      // If the file cannot be measured, estimate from the words: about 2.6 a second.
      const duration = meta?.format?.duration || Math.max(1.5, scene.voice.split(' ').length / 2.6);
      return { src: out.url, duration: Math.round(duration * 100) / 100, text: scene.voice, voiceId };
    } catch (err) {
      log(`voice: ${err.message}`);
      return null;
    }
  }));
}

/** Fetch a backdrop for each scene that asked for one, and point the scene at it. */
async function attachFootage(vidmoat, storyboard, format, log) {
  const wanted = storyboard.scenes.filter((sc) => sc.visual && sc.image < 0).slice(0, MAX_FOOTAGE);
  const found = await Promise.all(wanted.map((sc) =>
    findFootage(vidmoat, sc.visual, format, sceneDuration(sc) + 0.5).catch((err) => { log(`footage "${sc.visual}": ${err.message}`); return null; })));
  const footage = [];
  wanted.forEach((sc, i) => {
    if (!found[i]) return;
    sc.footage = footage.length;
    footage.push(found[i]);
  });
  return footage;
}

function failures(results) {
  return (results ?? []).flatMap((r) => {
    if (r && r.ok === false) return [`${r.op}: ${r.error ?? 'failed'}`];
    // A clip the timeline had to move is on the wrong layer: say so rather than ship it quietly.
    if (r?.data?.warning) return [`${r.op} ${r.data.clipId ?? ''}: ${r.data.warning}`];
    return [];
  });
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
  // Projects made before narration existed have no voice track; they simply stay silent.
  const missing = TRACK_ORDER.filter((name) => name !== 'voice' && tracks[name] === undefined);
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
  brief.images = assets.images.map((img) => ({ alt: img.alt, hint: img.hint, width: img.width, height: img.height, src: img.src, contentType: img.contentType }));
  emit('media', 'done', `${assets.images.length} image${assets.images.length === 1 ? '' : 's'}`);

  emit('write', 'active');
  const { storyboard, source, reason } = await writeStoryboard(brief, {
    goal: input.goal, length, format: FORMATS[format].label, client: anthropic, log,
  });
  emit('write', 'done', source === 'claude' ? `${storyboard.scenes.length} scenes` : 'Written from the page text');

  emit('build', 'active');
  const voiceId = VOICES[input.voice] ? input.voice : 'marin';
  const [created, music, footage, voices] = await Promise.all([
    vidmoat.createProject(`LinkReel · ${storyboard.brandName} · ${FORMATS[format].aspectRatio}`, setupCommands(format, storyboard.palette.background)),
    input.music === false ? null : findMusic(vidmoat, storyboard.musicQuery, 30).catch((err) => { log(`music: ${err.message}`); return null; }),
    attachFootage(vidmoat, storyboard, format, log),
    input.voiceover === false ? [] : recordVoices(vidmoat, storyboard, voiceId, { fetchImpl, log }),
  ]);
  assets.footage = footage;
  assets.voices = voices;
  assets.voiceId = voices.some(Boolean) ? voiceId : null;
  const projectId = created.project.id;
  const trackIds = (created.results ?? []).filter((r) => r.op === 'addTrack' && r.ok).map((r) => r.data?.trackId);
  if (trackIds.length !== TRACK_ORDER.length || trackIds.some((id) => typeof id !== 'number')) {
    throw new Error('Vidmoat did not create the layer tracks');
  }
  const tracks = Object.fromEntries(TRACK_ORDER.map((name, i) => [name, trackIds[i]]));
  const canvas = { width: created.project.settings.width, height: created.project.settings.height };

  const composed = compose({ storyboard, images: assets.images, footage, voices, logo: assets.logo, canvas, format, style, tracks, music, domain: brief.domain });
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
export async function rebuildVideo(input, { vidmoat, fetchImpl, log = () => {} }) {
  const format = FORMATS[input.format] ? input.format : 'vertical';
  const style = STYLES[input.style] ? input.style : 'sleek';
  // Media can only be files already in the Vidmoat library, never an arbitrary URL.
  const images = (Array.isArray(input.assets?.images) ? input.assets.images : []).slice(0, MAX_IMAGES).filter(checkAsset)
    .map(({ src, width, height, alt, hint }) => ({ src, width, height, alt: String(alt ?? ''), hint: String(hint ?? '') }));
  const logo = checkAsset(input.assets?.logo) ? { src: input.assets.logo.src, width: input.assets.logo.width, height: input.assets.logo.height } : null;
  const footage = (Array.isArray(input.assets?.footage) ? input.assets.footage : []).slice(0, MAX_FOOTAGE)
    .filter((f) => checkAsset(f) && Number.isFinite(f.duration) && f.duration > 0)
    .map(({ src, width, height, duration }) => ({ src, width, height, duration }));
  const music = typeof input.music?.src === 'string' && input.music.src.startsWith(MEDIA_PREFIX) ? input.music : null;

  const sceneCount = Math.min(Math.max(input.storyboard?.scenes?.length ?? 0, 2), 10);
  const storyboard = sanitizeStoryboard(input.storyboard, { images, footage, siteName: 'Brand', title: '', domain: '' }, { sceneCount, trustNumbers: true });

  const before = await vidmoat.getDocument(input.projectId);
  const tracks = tracksFromDocument(before);
  const canvas = { width: before.settings.width, height: before.settings.height };
  const domain = String(input.domain ?? '').replace(/[^a-z0-9.-]/gi, '').slice(0, 80);
  // Narration: keep the lines that still match, re-record the ones whose words changed.
  const voiceId = VOICES[input.assets?.voiceId] ? input.assets.voiceId : null;
  const existing = (Array.isArray(input.assets?.voices) ? input.assets.voices : []).slice(0, 12)
    .filter((v) => v && typeof v.src === 'string' && v.src.startsWith(MEDIA_PREFIX) && Number.isFinite(v.duration) && v.duration > 0 && v.duration < 60)
    .map(({ src, duration, text, voiceId: id }) => ({ src, duration, text: String(text ?? ''), voiceId: id }));
  const voices = voiceId && tracks.voice !== undefined ? await recordVoices(vidmoat, storyboard, voiceId, { existing, fetchImpl, log }) : [];
  const composed = compose({ storyboard, images, footage, voices, logo, canvas, format, style, tracks, music, domain });
  const { problems, lint } = await applyAll(vidmoat, input.projectId, [
    { op: 'clearTimeline' },
    { op: 'setProjectSettings', background: storyboard.palette.background },
    ...composed.commands,
  ]);
  const document = await vidmoat.getDocument(input.projectId);
  return describe({ projectId: input.projectId, storyboard, assets: { images, logo, footage, voices, voiceId: voices.some(Boolean) ? voiceId : null }, music, composed, document, lint, problems, format, style });
}
