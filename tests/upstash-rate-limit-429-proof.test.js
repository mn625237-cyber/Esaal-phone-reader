// Scanly — end-to-end proof, through the REAL api/extract-phone.js handler, that:
//   - the first 30 requests from one IP succeed and reach Gemini
//   - the 31st is rejected with HTTP 429 / {"error":"rate-limited"} and Gemini is
//     NEVER called for it
// No real image is sent (per project rule) — global.fetch is mocked for both the
// Upstash pipeline calls and the Gemini call, so no quota is consumed either way.
// Run: node tests/upstash-rate-limit-429-proof.test.js

let failures = 0, passed = 0;
function check(label, cond){ if (cond) passed++; else { failures++; console.error('FAIL:', label); } }

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function makeFakeUpstash() {
  const store = new Map();
  return {
    handle(bodyText) {
      const commands = JSON.parse(bodyText);
      const results = [];
      for (const [cmd, key, arg] of commands) {
        if (cmd === 'INCR') {
          const entry = store.get(key);
          if (!entry) { store.set(key, { count: 1 }); results.push({ result: 1 }); }
          else { entry.count += 1; results.push({ result: entry.count }); }
        } else if (cmd === 'EXPIRE') {
          results.push({ result: 1 });
        }
      }
      return results;
    },
  };
}

async function run() {
  process.env.GEMINI_API_KEY = 'dummy-key-for-local-test';
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = 'fake-token';

  const upstash = makeFakeUpstash();
  let geminiCallCount = 0, upstashCallCount = 0;
  const path = require('path');
  const modulePath = path.join(__dirname, '..', 'api', 'extract-phone.js');
  delete require.cache[require.resolve(modulePath)];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'upstash-rate-limit.js'))];

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.example')) {
      upstashCallCount += 1;
      return { ok: true, json: async () => upstash.handle(opts.body) };
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      geminiCallCount += 1;
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ phone: '01012345678' }) }] } }] }),
      };
    }
    throw new Error('unexpected fetch to ' + u);
  };

  const handler = require(modulePath);
  const results = [];
  for (let i = 1; i <= 31; i++) {
    const req = {
      method: 'POST',
      headers: { 'x-real-ip': '9.9.9.9' },
      body: { image: 'x'.repeat(50) },
    };
    const res = makeRes();
    await handler(req, res);
    results.push({ i, status: res.statusCode, body: res.body });
  }

  const first30 = results.slice(0, 30);
  const call31 = results[30];

  check('all of the first 30 calls got a non-429 status', first30.every(r => r.status !== 429));
  check('call #31 returned exactly HTTP 429', call31.status === 429);
  check('call #31 body is {"error":"rate-limited"}', JSON.stringify(call31.body) === JSON.stringify({ error: 'rate-limited' }));
  check('Gemini was called for all 30 allowed requests', geminiCallCount === 30);
  check('Gemini was never reached on the blocked 31st request (still 30, not 31)', geminiCallCount === 30);

  console.log(`\nUpstash was contacted ${upstashCallCount} times (31 INCR calls + 1 EXPIRE-on-first-request = 32 expected with the fix)`);
  console.log(`${passed}/${passed + failures} passing`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
