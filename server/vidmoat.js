// Thin client for the Vidmoat developer API (https://developer.vidmoat.com/developer/docs).
// The key is a server credential: it never leaves this process.

const BASE_URL = 'https://api.vidmoat.com/v1';
const API_VERSION = '2026-08-01';

export class VidmoatError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.name = 'VidmoatError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createVidmoat({ apiKey, baseUrl = BASE_URL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('VIDMOAT_KEY is not set');

  async function request(method, path, { body, query, raw = false, timeoutMs = 90_000 } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    // 429 and 503 are refused before anything runs, so they are the only
    // responses that are safe to retry for every method. Commands and renders
    // are not idempotent, so a network failure on a POST is never retried here.
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Vidmoat-Version': API_VERSION,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 20);
        await res.arrayBuffer().catch(() => {});
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        const err = parsed?.error ?? {};
        throw new VidmoatError(
          res.status,
          err.code ?? `http_${res.status}`,
          err.message ?? `Vidmoat answered ${res.status}`,
          parsed ?? text.slice(0, 500),
        );
      }
      if (raw) {
        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        };
      }
      return res.json();
    }
  }

  return {
    me: () => request('GET', '/me'),

    createProject: (name, commands) =>
      request('POST', '/projects', { body: { name: String(name).slice(0, 80), commands } }),

    applyCommands: (projectId, commands, { dryRun = false } = {}) =>
      request('POST', `/projects/${encodeURIComponent(projectId)}/commands`, {
        body: { commands, ...(dryRun ? { dryRun: true } : {}) },
      }),

    getProject: (projectId) => request('GET', `/projects/${encodeURIComponent(projectId)}`),

    /** The document verbatim: exactly what the editor, the player and the renderer read. */
    getDocument: async (projectId) => {
      const data = await request('GET', `/projects/${encodeURIComponent(projectId)}`, {
        query: { view: 'document' },
      });
      return data.project?.document ?? data.document;
    },

    deleteProject: (projectId) => request('DELETE', `/projects/${encodeURIComponent(projectId)}`),

    /** Layout lint and suggested preview times. Free, starts no browser. */
    previewInfo: (projectId) =>
      request('GET', `/projects/${encodeURIComponent(projectId)}/preview`),

    /** One exact frame as JPEG bytes. Free, limited to 10 a minute per key. */
    previewFrame: (projectId, at = 0) =>
      request('GET', `/projects/${encodeURIComponent(projectId)}/preview`, {
        query: { format: 'image', at },
        raw: true,
      }),

    importMedia: (url) =>
      request('POST', '/media/import', { body: { url }, timeoutMs: 130_000 }),

    /** Text to speech. Spends credits: 15 a call with OpenAI, up to 1,000 characters. */
    createSpeech: (text, { voiceId, instructions } = {}) =>
      request('POST', '/ai/speech', {
        body: { text, provider: 'openai', ...(voiceId ? { voiceId } : {}), ...(instructions ? { instructions } : {}), maxCredits: 15 },
        timeoutMs: 120_000,
      }),

    searchStock: (query, type = 'video', limit = 12) =>
      request('GET', '/stock/search', { query: { query, type, limit } }),

    createRender: (projectId, { format = 'mp4', quality = 'standard', resolution = 'full' } = {}) =>
      request('POST', '/renders', { body: { projectId, format, quality, resolution } }),

    getRender: (renderId) => request('GET', `/renders/${encodeURIComponent(renderId)}`),

    listRenders: (projectId, limit = 20) =>
      request('GET', '/renders', { query: { projectId, limit } }),
  };
}
