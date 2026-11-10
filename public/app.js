// LinkReel front end. Talks only to this site's own /api; no key is ever here.

const $ = (id) => document.getElementById(id);
const PLAYER_ORIGIN = 'https://www.vidmoat.com';
const PLAYER_CHANNEL = 'vidmoat.player.v1';
const ASPECT_ICON = { vertical: [9, 16], square: [13, 13], wide: [18, 10] };
const GOAL_LABEL = { ad: 'Ad', brand: 'Brand film', launch: 'Launch' };
const KIND_LABEL = { hook: 'Hook', feature: 'Point', stat: 'Number', cta: 'Close' };
const SWATCHES = [['background', 'Background'], ['surface', 'Second tone'], ['accent', 'Accent'], ['text', 'Text']];

const state = { video: null, player: null, revision: 0, playing: false, dirty: false, busy: false, renderTimer: null };

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

// ---------- Options ----------

const STYLE_DEMO = {
  punch: 'Stop the <i>scroll</i>',
  sleek: 'Made to <i>feel</i> premium',
  playful: 'Say it with <i>joy</i>',
};

/** Radio options. `render` returns the visible part of one option. */
function options(host, name, items, selected, render) {
  host.replaceChildren(...items.map((item) => {
    const label = document.createElement('label');
    label.className = 'opt';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name, value: item.id, checked: item.id === selected });
    label.append(input, render(item));
    return label;
  }));
}
const el = (tag, className, html) => Object.assign(document.createElement(tag), { className, innerHTML: html });

const styleCard = (item) => el('span', 'card',
  `<span class="swatchDemo demo-${item.id}"><b>${STYLE_DEMO[item.id] ?? item.label}</b></span><strong>${item.label}</strong><small>${item.hint ?? ''}</small>`);
const formatTile = (item) => {
  const [w, h] = ASPECT_ICON[item.id] ?? [14, 14];
  return el('span', 'tile', `<i style="width:${w * 2}px;height:${h * 2}px"></i>${item.label.split(' ').pop()}`);
};
const segment = (item) => el('span', 'segItem', `${item.label}${item.small ? `<small>${item.small}</small>` : ''}`);
const picked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;

async function loadConfig() {
  let config;
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    showFormError('Could not reach the server. Reload the page.');
    return;
  }
  options($('formats'), 'format', config.formats, store.get('format') ?? 'vertical', formatTile);
  options($('styles'), 'style', config.styles, store.get('style') ?? 'sleek', styleCard);
  options($('lengths'), 'length', config.lengths.map((l) => ({ id: l.id, label: `${l.scenes} scenes`, small: l.label })), store.get('length') ?? 'standard', segment);
  options($('goals'), 'goal', config.goals.map((g) => ({ id: g, label: GOAL_LABEL[g] ?? g })), store.get('goal') ?? 'ad', segment);
  $('accessRow').hidden = !config.needsAccessCode;
  $('access').value = store.get('access') ?? '';
  const notes = [];
  if (!config.ready) {
    notes.push('The server has no Vidmoat key yet, so it cannot make videos. Set VIDMOAT_KEY and restart.');
    $('go').disabled = true;
  } else if (!config.claude) {
    notes.push('Claude is not connected (no ANTHROPIC_API_KEY), so scripts are assembled from the page text instead of being written.');
  }
  $('setupNote').textContent = notes.join(' ');
  $('setupNote').hidden = !notes.length;
}

// ---------- Making a video ----------

function showFormError(message) {
  $('formError').textContent = message ?? '';
  $('formError').hidden = !message;
}

function setStep(step, status, detail) {
  const li = document.querySelector(`#steps li[data-step="${step}"]`);
  if (!li) return;
  li.className = status;
  li.querySelector('.detail').textContent = detail ?? '';
}

async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function make(event) {
  event.preventDefault();
  if (state.busy) return;
  const url = $('url').value.trim();
  if (!url) { showFormError('Paste a link first.'); $('url').focus(); return; }
  showFormError(null);
  for (const name of ['format', 'style', 'length', 'goal']) store.set(name, picked(name));
  store.set('access', $('access').value);

  state.busy = true;
  $('go').disabled = true;
  $('go').textContent = 'Working…';
  $('result').hidden = true;
  $('progress').hidden = false;
  document.querySelectorAll('#steps li').forEach((li) => { li.className = ''; li.querySelector('.detail').textContent = ''; });
  $('progress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let finished = null;
  let failure = null;
  try {
    const res = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': $('access').value },
      body: JSON.stringify({ url, format: picked('format'), style: picked('style'), length: picked('length'), goal: picked('goal'), music: $('music').checked }),
    });
    if (!res.ok) {
      failure = (await res.json().catch(() => ({}))).error ?? `The server answered ${res.status}.`;
    } else {
      await readStream(res, (msg) => {
        if (msg.type === 'step') setStep(msg.step, msg.status, msg.detail);
        else if (msg.type === 'done') finished = msg.video;
        else if (msg.type === 'error') failure = msg.error;
      });
      if (!finished && !failure) failure = 'The connection dropped before the video was ready. Try again.';
    }
  } catch {
    failure = 'The connection dropped before the video was ready. Try again.';
  }
  state.busy = false;
  $('go').disabled = false;
  $('go').textContent = 'Make my video';
  if (failure) {
    $('progress').hidden = true;
    showFormError(failure);
    return;
  }
  $('progress').hidden = true;
  showVideo(finished, { fresh: true });
}

// ---------- Result ----------

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const frameUrl = (video, at) => `/api/videos/${video.projectId}/frame?at=${at.toFixed(2)}&token=${encodeURIComponent(video.token)}`;

function showVideo(video, { fresh = false } = {}) {
  // A rebuild answers without the page facts; keep the ones from the first build.
  state.video = { ...video, page: video.page ?? state.video?.page, writer: video.writer ?? state.video?.writer };
  const v = state.video;
  state.dirty = false;
  $('apply').disabled = true;
  $('result').hidden = false;
  $('stage').dataset.format = v.format;
  $('videoTitle').textContent = v.storyboard.brandName;
  $('videoMeta').textContent = `${v.storyboard.scenes.length} scenes · ${v.duration.toFixed(1)}s${v.page ? ` · from ${v.page.domain}` : ''}`;
  $('clock').textContent = `0:00 / ${fmtTime(v.duration)}`;
  $('scrubFill').style.width = '0';

  // The poster is an exact frame from Vidmoat, so there is something true to
  // look at even before (or without) the interactive player.
  const first = v.timeline[0];
  $('poster').src = frameUrl(v, Math.min(first.start + first.duration * 0.7, v.duration - 0.1));

  const notices = [];
  if (v.writer?.source === 'fallback') notices.push(`Script assembled from the page text (${v.writer.reason ?? 'Claude was not used'}). Edit it below.`);
  for (const p of v.problems ?? []) notices.push(`A step was skipped: ${p}`);
  for (const l of v.lint ?? []) notices.push(`Layout check at ${l.time}s: ${l.message}`);
  $('notices').replaceChildren(...notices.slice(0, 6).map((text) => Object.assign(document.createElement('li'), { textContent: text })));

  renderBoard(v);
  $('musicCredit').textContent = v.music ? `Music: “${v.music.name}”${v.music.credit ? ` by ${v.music.credit}` : ''} (CC0 stock).` : '';

  if (fresh) {
    resetRender();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    $('renderStatus').textContent = 'Changes applied. Render again to get them in the MP4.';
  }
  loadPlayer(v);
}

function field(labelText, value, onInput, attrs = {}) {
  const wrap = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', ...attrs });
  input.addEventListener('input', () => { onInput(input.value); markDirty(); });
  label.append(input);
  wrap.append(label);
  return wrap;
}

function markDirty() {
  state.dirty = true;
  $('apply').disabled = false;
}

function renderBoard(v) {
  const sb = v.storyboard;
  $('brandName').value = sb.brandName;
  $('swatches').replaceChildren(...SWATCHES.map(([key, name]) => {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.title = name;
    const input = Object.assign(document.createElement('input'), { type: 'color', value: sb.palette[key] });
    input.setAttribute('aria-label', `${name} colour`);
    input.addEventListener('input', () => { sb.palette[key] = input.value; markDirty(); });
    label.append(input);
    return label;
  }));
  $('scenes').replaceChildren(...sb.scenes.map((scene, i) => {
    const li = document.createElement('li');
    li.className = 'scene';
    li.dataset.index = i;
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'sceneJump';
    jump.title = 'Show this scene';
    jump.innerHTML = `<b>${i + 1}</b><small>${KIND_LABEL[scene.kind] ?? scene.kind}</small>`;
    jump.addEventListener('click', () => jumpTo(i));
    const fields = document.createElement('div');
    fields.className = 'sceneFields';
    fields.append(field(scene.kind === 'stat' ? 'Label for the number' : 'Headline', scene.headline, (val) => { scene.headline = val; }, { maxLength: 64 }));
    const row = document.createElement('div');
    row.className = 'sceneRow';
    if (scene.kind === 'stat') {
      row.append(
        field('Number', String(scene.statValue), (val) => { scene.statValue = Number(val.replace(/[^\d.]/g, '')) || 0; }, { inputMode: 'decimal' }),
        field('After the number', scene.statSuffix, (val) => { scene.statSuffix = val; }, { maxLength: 3 }),
      );
    } else if (scene.kind === 'cta') {
      row.append(
        field('Button', scene.cta, (val) => { scene.cta = val; }, { maxLength: 24 }),
        field('Coloured words', scene.highlight, (val) => { scene.highlight = val; }, { maxLength: 40 }),
      );
    } else {
      row.append(
        field('Supporting line', scene.sub, (val) => { scene.sub = val; }, { maxLength: 96 }),
        field('Coloured words', scene.highlight, (val) => { scene.highlight = val; }, { maxLength: 40 }),
      );
    }
    fields.append(row);
    li.append(jump, fields);
    return li;
  }));
}

async function applyChanges() {
  const v = state.video;
  if (!v || !state.dirty || state.busy) return;
  state.busy = true;
  $('apply').disabled = true;
  $('apply').textContent = 'Applying…';
  v.storyboard.brandName = $('brandName').value;
  try {
    const res = await fetch(`/api/videos/${v.projectId}/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Video-Token': v.token },
      body: JSON.stringify({ storyboard: v.storyboard, assets: v.assets, music: v.music, format: v.format, style: v.style, domain: v.page?.domain ?? '' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Could not apply the changes.');
    showVideo(body.video);
  } catch (err) {
    $('notices').prepend(Object.assign(document.createElement('li'), { textContent: err.message }));
    $('apply').disabled = false;
  }
  state.busy = false;
  $('apply').textContent = 'Apply changes';
}

// ---------- Preview: Vidmoat's embeddable player, with exact frames as the fallback ----------

function loadPlayer(v) {
  state.revision += 1;
  state.playing = false;
  setPlaying(false);
  const host = $('playerHost');
  if (state.player?.ready) {
    // Same player, new document.
    postToPlayer({ type: 'document', document: v.document, revision: state.revision, time: 0 });
    return;
  }
  host.classList.remove('on');
  $('playBtn').disabled = true;
  $('previewNote').textContent = 'Loading the interactive preview…';
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) {
    $('previewNote').textContent = 'The interactive player needs https. Showing exact frames instead: use the scene buttons.';
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.title = 'Video preview';
  iframe.allow = 'autoplay; fullscreen';
  iframe.src = `${PLAYER_ORIGIN}/embed/player?parentOrigin=${encodeURIComponent(location.origin)}`;
  host.replaceChildren(iframe);
  state.player = { iframe, ready: false, loaded: false };
  clearTimeout(state.playerTimer);
  state.playerTimer = setTimeout(() => {
    if (!state.player?.loaded) $('previewNote').textContent = 'The interactive player did not load. Showing exact frames instead: use the scene buttons.';
  }, 20000);
}

function postToPlayer(message) {
  state.player?.iframe.contentWindow?.postMessage({ channel: PLAYER_CHANNEL, ...message }, PLAYER_ORIGIN);
}

window.addEventListener('message', (event) => {
  const player = state.player;
  // Both sides check the source and the exact origin.
  if (!player || event.source !== player.iframe.contentWindow || event.origin !== PLAYER_ORIGIN || event.data?.channel !== PLAYER_CHANNEL) return;
  const msg = event.data;
  if (msg.type === 'ready') {
    player.ready = true;
    postToPlayer({ type: 'document', document: state.video.document, revision: state.revision, time: 0 });
  } else if (msg.type === 'loaded') {
    player.loaded = true;
    $('playerHost').classList.add('on');
    $('playBtn').disabled = false;
    $('bigPlay').hidden = false;
    $('previewNote').textContent = 'Live preview. Nothing is exported until you render.';
  } else if (msg.type === 'state') {
    const duration = state.video.duration;
    const time = Math.min(msg.time ?? 0, duration);
    $('scrubFill').style.width = `${(time / duration) * 100}%`;
    $('clock').textContent = `${fmtTime(time)} / ${fmtTime(duration)}`;
    setPlaying(Boolean(msg.playing) && time < duration - 0.05);
    highlightScene(time);
    if (msg.playing && time >= duration - 0.05) postToPlayer({ type: 'pause' });
  } else if (msg.type === 'audio' && msg.state === 'suspended' && state.playing) {
    $('previewNote').textContent = 'Tap the video once to turn the sound on.';
  } else if (msg.type === 'error') {
    $('previewNote').textContent = `The player reported a problem (${msg.message ?? 'unknown'}). Use the scene buttons to see exact frames.`;
  }
});

function setPlaying(playing) {
  state.playing = playing;
  $('playBtn').textContent = playing ? 'Pause' : 'Play';
  $('bigPlay').hidden = playing || !state.player?.loaded;
}

function togglePlay() {
  if (!state.player?.loaded) return;
  if (state.playing) {
    postToPlayer({ type: 'pause' });
  } else {
    const atEnd = parseFloat($('scrubFill').style.width) >= 99;
    if (atEnd) postToPlayer({ type: 'seek', time: 0 });
    postToPlayer({ type: 'play' });
  }
}

function highlightScene(time) {
  const current = state.video.timeline.findLast((s) => time >= s.start)?.index ?? 0;
  document.querySelectorAll('#scenes .scene').forEach((li) => li.classList.toggle('current', Number(li.dataset.index) === current));
}

function jumpTo(index) {
  const v = state.video;
  const scene = v.timeline[index];
  if (!scene) return;
  const at = Math.min(scene.start + scene.duration * 0.7, v.duration - 0.1);
  if (state.player?.loaded) {
    postToPlayer({ type: 'pause' });
    postToPlayer({ type: 'seek', time: at });
  } else {
    $('poster').src = frameUrl(v, at);
    highlightScene(at);
    $('scrubFill').style.width = `${(at / v.duration) * 100}%`;
    $('clock').textContent = `${fmtTime(at)} / ${fmtTime(v.duration)}`;
  }
}

// ---------- Render ----------

function resetRender() {
  clearInterval(state.renderTimer);
  $('renderBtn').disabled = false;
  $('renderBtn').textContent = 'Render MP4';
  $('renderStatus').textContent = '';
  $('download').hidden = true;
  $('final').hidden = true;
  $('final').removeAttribute('src');
}

function finishRender(render, note = '') {
  clearInterval(state.renderTimer);
  $('renderBtn').disabled = false;
  $('renderBtn').textContent = 'Render again';
  if (render.status === 'COMPLETED' && render.url) {
    $('renderStatus').textContent = `Your MP4 is ready.${note}`;
    $('download').href = render.url;
    $('download').hidden = false;
    $('final').src = render.url;
    $('final').hidden = false;
  } else {
    $('renderStatus').textContent = render.status === 'CANCELLED' ? 'The render was cancelled.' : `The render failed: ${render.error ?? 'no reason given'}.`;
  }
}

async function render() {
  const v = state.video;
  if (!v) return;
  if (state.dirty && !confirm('You have changes that are not applied yet. Render without them?')) return;
  resetRender();
  $('renderBtn').disabled = true;
  $('renderBtn').textContent = 'Rendering…';
  $('renderStatus').textContent = 'Queued…';
  const headers = { 'Content-Type': 'application/json', 'X-Video-Token': v.token };
  let job;
  try {
    const res = await fetch(`/api/videos/${v.projectId}/render`, { method: 'POST', headers, body: '{}' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Could not start the render.');
    job = body;
  } catch (err) {
    $('renderBtn').disabled = false;
    $('renderBtn').textContent = 'Render MP4';
    $('renderStatus').textContent = err.message;
    return;
  }
  const done = (r) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(r.status);
  if (done(job.render)) {
    finishRender(job.render, job.test ? ' This is Vidmoat\'s sample file: the server is using a test key, which does not render for real.' : '');
    return;
  }
  // A render is a queued job. Poll every five seconds, for at most ten minutes.
  let polls = 0;
  state.renderTimer = setInterval(async () => {
    polls += 1;
    try {
      const res = await fetch(`/api/videos/${v.projectId}/renders/${job.render.id}`, { headers });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      if (done(body.render)) finishRender(body.render);
      else $('renderStatus').textContent = body.render.status === 'PENDING' ? 'Waiting for a render slot…' : `Rendering… ${body.render.progress ?? 0}%`;
    } catch { /* a missed poll is fine; the next one will catch up */ }
    if (polls >= 120 && !$('renderBtn').textContent.includes('again')) {
      clearInterval(state.renderTimer);
      $('renderBtn').disabled = false;
      $('renderBtn').textContent = 'Render MP4';
      $('renderStatus').textContent = 'This is taking longer than usual. The render is still queued; press Render MP4 later to pick it up.';
    }
  }, 5000);
}

// ---------- Wiring ----------

$('make').addEventListener('submit', make);
$('apply').addEventListener('click', applyChanges);
$('brandName').addEventListener('input', markDirty);
$('playBtn').addEventListener('click', togglePlay);
$('bigPlay').addEventListener('click', togglePlay);
$('renderBtn').addEventListener('click', render);
$('again').addEventListener('click', () => {
  $('hero').scrollIntoView({ behavior: 'smooth' });
  $('url').focus();
  $('url').select();
});

loadConfig();
