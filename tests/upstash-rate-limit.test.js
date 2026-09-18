'use strict';

const assert = require('assert');
const {
  getUpstashConfig,
  getClientIp,
  hashClientIp,
  checkRateLimit,
} = require('../lib/upstash-rate-limit');

(async () => {
  const old = {
    url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    oldUrl: process.env.UPSTASH_REDIS_REST_URL,
    oldToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://legacy.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'legacy-token';
  assert.deepStrictEqual(getUpstashConfig(), { url: 'https://legacy.example', token: 'legacy-token' });

  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = 'https://connector.example';
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = 'connector-token';
  assert.deepStrictEqual(getUpstashConfig(), { url: 'https://connector.example', token: 'connector-token' });

  assert.strictEqual(getClientIp({ headers: { 'x-forwarded-for': ' 1.2.3.4, 5.6.7.8 ' } }), '1.2.3.4');
  assert.strictEqual(getClientIp({ headers: { 'x-real-ip': '9.8.7.6' } }), '9.8.7.6');
  assert.strictEqual(getClientIp({}), 'unknown');
  assert.match(hashClientIp('1.2.3.4'), /^[a-f0-9]{64}$/);
  assert.notStrictEqual(hashClientIp('1.2.3.4'), '1.2.3.4');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ result: 31 }, { result: 1 }],
  });
  const limited = await checkRateLimit({ req: { headers: { 'x-forwarded-for': '1.2.3.4' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(limited.allowed, false);
  assert.strictEqual(limited.remaining, 0);
  global.fetch = originalFetch;

  Object.assign(process.env, {
    UPSTASH_REDIS_REST_KV_REST_API_URL: old.url || '',
    UPSTASH_REDIS_REST_KV_REST_API_TOKEN: old.token || '',
    UPSTASH_REDIS_REST_URL: old.oldUrl || '',
    UPSTASH_REDIS_REST_TOKEN: old.oldToken || '',
  });
  console.log('upstash-rate-limit.test.js: all passing');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
