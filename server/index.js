// LinkReel server: the browser talks to this, this talks to Vidmoat and Claude.
// Neither key ever reaches the page.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVidmoat, VidmoatError } from './vidmoat.js';
import { buildVideo, rebuildVideo } from './pipeline.js';
import { LinkError } from './scrape.js';
import { claudeConfigured, LENGTHS, GOALS } from './creative.js';
import { FORMATS, STYLES } from './compose.js';
import { createSigner, createRateLimiter } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function friendly(err) {
  if (err instanceof LinkError) return { status: 422, message: err.message };
  if (err instanceof VidmoatError) {
    const byCode = {
      insufficient_credits: 'The Vidmoat account is out of credits.',
      quota_exceeded: 'The Vidmoat plan limit was reached (exports this month, renders at once, or projects).',
      plan_required: 'The Vidmoat plan does not include this feature.',
      rate_limited: 'Too many requests to Vidmoat right now. Try again in a minute.',
      unauthorized: 'The Vidmoat API key was refused. Check VIDMOAT_KEY.',
      forbidden: 'The Vidmoat API key is missing a scope this needs.',
    };
    return { status: err.status === 404 ? 404 : 502, message: byCode[err.code] ?? `Vidmoat: ${err.message}` };
  }
  return { status: 500, message: 'Something went wrong on our side. Try again.' };
}

export function createApp({ env = process.env, vidmoat, anthropic, log = console.error } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === '1' ? 1 : false);
  app.use(express.json({ limit: '200kb' }));

  const configured = Boolean(vidmoat || env.VIDMOAT_KEY);
  const api = vidmoat ?? (env.VIDMOAT_KEY ? createVidmoat({ apiKey: env.VIDMOAT_KEY }) : null);
  // Tokens stay valid across restarts and instances as long as the secret does.
  const signer = createSigner(env.APP_SECRET || env.VIDMOAT_KEY || crypto.randomBytes(32).toString('hex'));
  const createLimit = createRateLimiter({ limit: Number(env.VIDEOS_PER_HOUR) || 6, windowMs: 3_600_000 });
  const renderLimit = createRateLimiter({ limit: Number(env.RENDERS_PER_HOUR) || 6, windowMs: 3_600_000 });
  const frameLimit = createRateLimiter({ limit: 8, windowMs: 60_000 }); // Vidmoat allows 10 frames a minute per key
  const accessCode = env.ACCESS_CODE || '';

  const requireApi = (req, res, next) => (api ? next() : res.status(503).json({ error: 'The server has no VIDMOAT_KEY yet.' }));
  const requireAccess = (req, res, next) => {
    if (!accessCode) return next();
    const given = Buffer.from(String(req.get('x-access-code') ?? ''));
    const want = Buffer.from(accessCode);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
    return res.status(401).json({ error: 'This site needs an access code.', code: 'access_code' });
  };
  const requireToken = (req, res, next) => {
    const token = req.get('x-video-token') ?? req.query.token;
    if (!/^[a-z0-9]{6,64}$/i.test(req.params.id) || !signer.verify(req.params.id, token)) {
      return res.status(404).json({ error: 'No such video.' });
    }
    return next();
  };
  const fail = (res, err) => {
    const { status, message } = friendly(err);
    if (status >= 500) log(err);
    res.status(status).json({ error: message });
  };

  app.get('/api/config', (req, res) => {
    res.json({
      ready: configured,
      claude: Boolean(anthropic) || claudeConfigured(env),
      needsAccessCode: Boolean(accessCode),
      formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, hint: f.hint })),
      styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, hint: s.hint })),
      lengths: Object.entries(LENGTHS).map(([id, l]) => ({ id, label: l.label, scenes: l.scenes })),
      goals: Object.keys(GOALS),
    });
  });

  // Link in, video out. The answer is newline-delimited JSON so the page can
  // show each stage as it happens: {type:'step'}… then {type:'done'} or {type:'error'}.
  app.post('/api/videos', requireApi, requireAccess, async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url || url.length > 2000) return res.status(422).json({ error: 'Paste a link first.' });
    const quota = createLimit.take(req.ip);
    if (!quota.ok) {
      return res.status(429).set('Retry-After', String(quota.retryAfterSec))
        .json({ error: `You have made a lot of videos. Try again in ${Math.ceil(quota.retryAfterSec / 60)} minutes.` });
    }
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
    try {
      const video = await buildVideo(
        { url, format: req.body.format, style: req.body.style, length: req.body.length, goal: req.body.goal, music: req.body.music !== false },
        { vidmoat: api, anthropic, emit: (step, status, detail) => send({ type: 'step', step, status, detail }), log },
      );
      send({ type: 'done', video: { ...video, token: signer.sign(video.projectId) } });
    } catch (err) {
      const { status, message } = friendly(err);
      if (status >= 500) log(err);
      send({ type: 'error', error: message });
    }
    res.end();
  });

  // Apply hand edits to the storyboard and lay the timeline out again.
  app.post('/api/videos/:id/rebuild', requireApi, requireToken, async (req, res) => {
    try {
      const video = await rebuildVideo({ ...req.body, projectId: req.params.id }, { vidmoat: api });
      res.json({ video: { ...video, token: signer.sign(video.projectId) } });
    } catch (err) { fail(res, err); }
  });

  // One exact frame, drawn by the same pipeline as the export. Free.
  app.get('/api/videos/:id/frame', requireApi, requireToken, async (req, res) => {
    if (!frameLimit.take('all').ok) return res.status(429).json({ error: 'Frames are limited. Try again shortly.' });
    try {
      const at = Math.max(0, Math.min(Number(req.query.at) || 0, 600));
      const frame = await api.previewFrame(req.params.id, at);
      res.set({ 'Content-Type': frame.contentType, 'Cache-Control': 'private, max-age=60' }).send(frame.buffer);
    } catch (err) { fail(res, err); }
  });

  // Queue the real export. Renders use the account's export allowance, so an
  // unfinished job for the same project is returned instead of queuing a second.
  app.post('/api/videos/:id/render', requireApi, requireToken, async (req, res) => {
    try {
      const existing = await api.listRenders(req.params.id, 10);
      const running = (existing.data ?? []).find((r) => r.status === 'PENDING' || r.status === 'PROCESSING');
      if (running) return res.json({ render: running, reused: true });
      const quota = renderLimit.take(req.ip);
      if (!quota.ok) return res.status(429).json({ error: 'Render limit reached for now. Try again later.' });
      const quality = ['draft', 'standard', 'high'].includes(req.body?.quality) ? req.body.quality : 'standard';
      const out = await api.createRender(req.params.id, { format: 'mp4', quality });
      res.status(202).json({ render: out.render, applied: out.applied ?? null, test: out.test === true || out.render?.test === true });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/videos/:id/renders/:renderId', requireApi, requireToken, async (req, res) => {
    try {
      const { render } = await api.getRender(req.params.renderId);
      // A render id is only readable through the project it belongs to.
      if (render.projectId !== req.params.id) return res.status(404).json({ error: 'No such render.' });
      res.json({ render });
    } catch (err) { fail(res, err); }
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'], maxAge: '5m' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`LinkReel on http://localhost:${port}`);
    if (!process.env.VIDMOAT_KEY) console.log('VIDMOAT_KEY is not set: the page loads but cannot make videos.');
    if (!claudeConfigured()) console.log('ANTHROPIC_API_KEY is not set: storyboards are written from the page text, without Claude.');
  });
}
