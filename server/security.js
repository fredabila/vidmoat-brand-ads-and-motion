// Small, dependency-free guards: signed project tokens and an in-memory rate limit.

import crypto from 'node:crypto';

/**
 * Every project lives on the site owner's Vidmoat account, so a project id alone
 * must not be enough to read, rebuild or render it. The creator gets a token
 * bound to the id; every later call has to present it.
 */
export function createSigner(secret) {
  const key = crypto.createHash('sha256').update(`linkreel:${secret}`).digest();
  const sign = (projectId) => crypto.createHmac('sha256', key).update(String(projectId)).digest('base64url');
  const verify = (projectId, token) => {
    const expected = Buffer.from(sign(projectId));
    const given = Buffer.from(String(token ?? ''));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  };
  return { sign, verify };
}

/** Sliding-window limiter keyed by caller. Good for one instance; put a shared store behind it to scale out. */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfterSec: Math.ceil((windowMs - (t - recent[0])) / 1000) };
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k);
      return { ok: true, remaining: limit - recent.length };
    },
  };
}
