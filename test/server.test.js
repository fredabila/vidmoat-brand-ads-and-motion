import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { createSigner, createRateLimiter } from '../server/security.js';

function fakeVidmoat(calls = []) {
  return {
    listRenders: async () => ({ data: [] }),
    createRender: async (id) => { calls.push(['render', id]); return { render: { id: 'r1', projectId: id, status: 'PENDING', progress: 0 } }; },
    getRender: async (rid) => ({ render: { id: rid, projectId: 'proj12345', status: 'COMPLETED', url: 'https://api.vidmoat.com/exports/x.mp4' } }),
    previewFrame: async () => ({ buffer: Buffer.from('jpg'), contentType: 'image/jpeg' }),
  };
}
async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('a project can only be touched with its token', async () => {
  const calls = [];
  const env = { APP_SECRET: 'secret', VIDEOS_PER_HOUR: '2' };
  const { base, close } = await listen(createApp({ env, vidmoat: fakeVidmoat(calls), log: () => {} }));
  const token = createSigner('secret').sign('proj12345');
  try {
    assert.equal((await fetch(`${base}/api/videos/proj12345/render`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/api/videos/proj12345/frame?token=nope`)).status, 404);
    assert.equal(calls.length, 0);

    const ok = await fetch(`${base}/api/videos/proj12345/render`, { method: 'POST', headers: { 'x-video-token': token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 202);
    assert.deepEqual(calls, [['render', 'proj12345']]);

    // A render that belongs to another project is not readable through this one.
    const otherToken = createSigner('secret').sign('other9999');
    assert.equal((await fetch(`${base}/api/videos/other9999/renders/r1`, { headers: { 'x-video-token': otherToken } })).status, 404);
    assert.equal((await fetch(`${base}/api/videos/proj12345/renders/r1`, { headers: { 'x-video-token': token } })).status, 200);

    const frame = await fetch(`${base}/api/videos/proj12345/frame?at=1&token=${token}`);
    assert.equal(frame.headers.get('content-type'), 'image/jpeg');

    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.ready, true);
    assert.equal(config.formats.length, 3);
  } finally { close(); }
});

test('a private link is refused before anything is created', async () => {
  const { base, close } = await listen(createApp({ env: { APP_SECRET: 's' }, vidmoat: fakeVidmoat(), log: () => {} }));
  try {
    const res = await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:1/' }) });
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).type, 'error');
    assert.match(lines.at(-1).error, /private address/);
    assert.equal((await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 422);
  } finally { close(); }
});

test('an access code, when set, gates video creation', async () => {
  const { base, close } = await listen(createApp({ env: { APP_SECRET: 's', ACCESS_CODE: 'letmein' }, vidmoat: fakeVidmoat(), log: () => {} }));
  try {
    const post = (code) => fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-access-code': code }, body: JSON.stringify({ url: 'http://127.0.0.1:1/' }) });
    assert.equal((await post('wrong')).status, 401);
    assert.equal((await post('letmein')).status, 200);
  } finally { close(); }
});

test('without a Vidmoat key the API says so', async () => {
  const { base, close } = await listen(createApp({ env: {}, log: () => {} }));
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).ready, false);
    assert.equal((await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://example.com"}' })).status, 503);
  } finally { close(); }
});

test('signer and rate limiter', () => {
  const a = createSigner('one');
  assert.ok(a.verify('p1', a.sign('p1')));
  assert.ok(!a.verify('p2', a.sign('p1')));
  assert.ok(!createSigner('two').verify('p1', a.sign('p1')));
  let now = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.ok(limiter.take('ip').ok && limiter.take('ip').ok);
  assert.equal(limiter.take('ip').ok, false);
  assert.ok(limiter.take('other').ok);
  now = 1001;
  assert.ok(limiter.take('ip').ok);
});
