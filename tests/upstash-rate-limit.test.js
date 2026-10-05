'use strict';

const assert = require('assert');
const {
  getUpstashConfig,
  getClientIp,
  hashClientIp,
  checkRateLimit,
} = require('../lib/upstash-rate-limit');

function makeFakeUpstash() {
  const store = new Map();
  let now = 0;
  return {
    setNow(ms) { now = ms; },
    handle(bodyText) {
      const commands = JSON.parse(bodyText);
      const results = [];
      for (const [cmd, key, arg] of commands) {
        if (cmd === 'INCR') {
          const entry = store.get(key);
          if (!entry || entry.expiresAtMs <= now) {
            store.set(key, { count: 1, expiresAtMs: Infinity });
            results.push({ result: 1 });
          } else {
            entry.count += 1;
            results.push({ result: entry.count });
          }
        } else if (cmd === 'EXPIRE') {
          const entry = store.get(key);
          if (entry) entry.expiresAtMs = now + arg * 1000;
          results.push({ result: 1 });
        } else {
          throw new Error('unsupported command in test fake: ' + cmd);
        }
      }
      return results;
    },
    clear() { store.clear(); },
  };
}

(async () => {
  const old = {
    url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    oldUrl: process.env.UPSTASH_REDIS_REST_URL,
    oldToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    hashSecret: process.env.RATE_LIMIT_HASH_SECRET,
  };

  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://legacy.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'legacy-token';
  assert.deepStrictEqual(getUpstashConfig(), { url: 'https://legacy.example', token: 'legacy-token' });

  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = 'https://connector.example';
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = 'connector-token';
  assert.deepStrictEqual(getUpstashConfig(), { url: 'https://connector.example', token: 'connector-token' });

  assert.strictEqual(
    getClientIp({ headers: { 'x-real-ip': '9.8.7.6', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }),
    '9.8.7.6',
    'x-real-ip must take priority over x-forwarded-for when both are present'
  );
  assert.strictEqual(getClientIp({ headers: { 'x-forwarded-for': ' 1.2.3.4, 5.6.7.8 ' } }), '1.2.3.4');
  assert.strictEqual(getClientIp({ headers: { 'x-real-ip': '9.8.7.6' } }), '9.8.7.6');
  assert.strictEqual(getClientIp({}), 'unknown');

  delete process.env.RATE_LIMIT_HASH_SECRET;
  const plainHash = hashClientIp('1.2.3.4');
  assert.match(plainHash, /^[a-f0-9]{64}$/, 'hash must be a 64-char hex SHA-256 digest');
  assert.notStrictEqual(plainHash, '1.2.3.4');
  assert.ok(!plainHash.includes('1.2.3.4'), 'hash output must not contain the raw IP as a substring');
  process.env.RATE_LIMIT_HASH_SECRET = 'test-secret';
  const hmacHash = hashClientIp('1.2.3.4');
  assert.notStrictEqual(hmacHash, plainHash, 'HMAC (RATE_LIMIT_HASH_SECRET set) must differ from the plain SHA-256 fallback');
  delete process.env.RATE_LIMIT_HASH_SECRET;

  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = 'fake-token';
  const fake = makeFakeUpstash();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (opts.headers.Authorization !== 'Bearer fake-token') throw new Error('unexpected/missing auth header in test');
    const results = fake.handle(opts.body);
    return { ok: true, json: async () => results };
  };

  fake.clear(); fake.setNow(0);
  const r1 = await checkRateLimit({ req: { headers: { 'x-real-ip': '1.1.1.1' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 29);

  fake.setNow(1000);
  const r2 = await checkRateLimit({ req: { headers: { 'x-real-ip': '1.1.1.1' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 28);

  fake.clear(); fake.setNow(0);
  for (let i = 0; i < 30; i++) {
    await checkRateLimit({ req: { headers: { 'x-real-ip': '2.2.2.2' } }, endpoint: 'extract-phone', limit: 30 });
  }
  const over = await checkRateLimit({ req: { headers: { 'x-real-ip': '2.2.2.2' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(over.allowed, false);
  assert.strictEqual(over.remaining, 0);

  fake.clear(); fake.setNow(0);
  for (let i = 0; i < 30; i++) {
    fake.setNow(i * 1000);
    await checkRateLimit({ req: { headers: { 'x-real-ip': '3.3.3.3' } }, endpoint: 'extract-phone', limit: 30 });
  }
  fake.setNow(59000);
  const stillBlocked = await checkRateLimit({ req: { headers: { 'x-real-ip': '3.3.3.3' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(stillBlocked.allowed, false, 'must still be blocked just before the original window elapses');
  fake.setNow(60000);
  const resetByElapsedTime = await checkRateLimit({ req: { headers: { 'x-real-ip': '3.3.3.3' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(resetByElapsedTime.allowed, true, 'window must reset ~60s after it started, regardless of continued requests in between');

  global.fetch = async () => { throw new Error('simulated network failure'); };
  const failOpenResult = await checkRateLimit({ req: { headers: { 'x-real-ip': '4.4.4.4' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(failOpenResult.allowed, true, 'must fail OPEN when Upstash is unreachable');
  assert.strictEqual(failOpenResult.degraded, true);
  global.fetch = async (url, opts) => {
    const results = fake.handle(opts.body);
    return { ok: true, json: async () => results };
  };

  const savedUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const noConfigResult = await checkRateLimit({ req: { headers: { 'x-real-ip': '5.5.5.5' } }, endpoint: 'extract-phone', limit: 30 });
  assert.strictEqual(noConfigResult.allowed, true);
  assert.strictEqual(noConfigResult.configured, false);
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = savedUrl;
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = savedToken;

  fake.clear(); fake.setNow(0);
  let sentBody = null;
  global.fetch = async (url, opts) => { sentBody = opts.body; const results = fake.handle(opts.body); return { ok: true, json: async () => results }; };
  await checkRateLimit({ req: { headers: { 'x-real-ip': '6.6.6.6' } }, endpoint: 'extract-phone', limit: 30 });
  assert.ok(!sentBody.includes('6.6.6.6'), 'the raw client IP must never be sent to Upstash');

  global.fetch = originalFetch;

  Object.assign(process.env, {
    UPSTASH_REDIS_REST_KV_REST_API_URL: old.url || '',
    UPSTASH_REDIS_REST_KV_REST_API_TOKEN: old.token || '',
    UPSTASH_REDIS_REST_URL: old.oldUrl || '',
    UPSTASH_REDIS_REST_TOKEN: old.oldToken || '',
    RATE_LIMIT_HASH_SECRET: old.hashSecret || '',
  });
  console.log('upstash-rate-limit.test.js: all passing (covers window-start, mid-window-allowed, over-limit-429, EXPIRE-not-renewed-fix, fail-open x2, no-raw-IP-leak, x-real-ip-priority, HMAC-vs-plain-hash)');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
