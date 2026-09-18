'use strict';

const crypto = require('crypto');

const WINDOW_SECONDS = 60;

function header(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function getClientIp(req) {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) {
    const first = String(forwarded).split(',').map((value) => value.trim()).find(Boolean);
    if (first) return first;
  }
  const realIp = header(req, 'x-real-ip');
  return realIp ? String(realIp).trim() : 'unknown';
}

function hashClientIp(ip) {
  // A keyed HMAC is preferred when RATE_LIMIT_HASH_SECRET is configured. The
  // fallback keeps the integration zero-config with Vercel's Upstash connector;
  // it is a pseudonymous abuse-control key, not an authentication identity.
  const secret = process.env.RATE_LIMIT_HASH_SECRET;
  const hash = secret
    ? crypto.createHmac('sha256', secret)
    : crypto.createHash('sha256');
  return hash.update(String(ip)).digest('hex');
}

function getUpstashConfig() {
  return {
    // Names created by Vercel's "Upstash for Redis" integration.
    url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

async function checkRateLimit({ req, endpoint, limit }) {
  const { url, token } = getUpstashConfig();
  console.info('[rate-limit] Upstash configuration', {
    endpoint,
    urlConfigured: Boolean(url),
    tokenConfigured: Boolean(token),
  });
  if (!url || !token) {
    console.warn('[rate-limit] Upstash configuration missing — failing open', { endpoint });
    return { allowed: true, configured: false, degraded: true, remaining: null };
  }

  const key = `ratelimit:${endpoint}:${hashClientIp(getClientIp(req))}`;
  const pipelineUrl = `${url.replace(/\/$/, '')}/pipeline`;

  try {
    const response = await fetch(pipelineUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, WINDOW_SECONDS],
      ]),
    });

    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const results = await response.json();
    const count = Number(results?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error('Invalid Upstash counter response');

    const allowed = count <= limit;
    return {
      allowed,
      configured: true,
      degraded: false,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: allowed ? 0 : WINDOW_SECONDS,
    };
  } catch (error) {
    console.error('[rate-limit] Upstash check failed', {
      endpoint,
      error: error && error.message ? error.message : 'unknown error',
    });
    return { allowed: true, configured: true, degraded: true, remaining: null };
  }
}

module.exports = {
  WINDOW_SECONDS,
  checkRateLimit,
  getClientIp,
  hashClientIp,
  getUpstashConfig,
};
