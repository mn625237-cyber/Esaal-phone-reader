// Phase 10 — standalone regression tests for items A (Gemini API Protection / rate
// limiting) and B (API Error Privacy) on both api/extract-phone.js and
// api/extract-receipt.js.
//
// IMPORTANT — HONESTY NOTE: this file was written and run inside a sandboxed
// environment with NO network access and NO visibility into this repo's actual
// tests/run-all.js, tests/load-core-functions.js, or any other existing test
// infrastructure (they were not available to review). It is a plain, self-contained
// Node script with zero dependencies — run it directly:
//
//   node tests/phase10-api.test.js
//
// It does NOT call the real Gemini API or a real Upstash instance (no network in this
// sandbox, and doing so would cost real quota/money anyway) — global.fetch is mocked
// per test case. This proves the BRANCHING LOGIC is correct; it does not replace a real
// end-to-end request against your live Vercel deployment with real Upstash credentials.
// If you want this wired into tests/run-all.js as a proper suite entry, send me that
// file's actual content and I'll integrate it precisely instead of guessing its shape.

const assert = require('assert');
const path = require('path');

let failures = 0;
let passed = 0;

function check(label, cond) {
  if (cond) { passed++; }
  else { failures++; console.error('FAIL:', label); }
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function loadHandlerWithMocks(modulePath, { upstashConfigured, simulatedCount, upstashThrows, geminiOk = true, geminiStatus = 502, geminiRawErrorText = 'INTERNAL_GEMINI_DIAGNOSTIC_TEXT_SHOULD_NEVER_LEAK' }) {
  delete require.cache[require.resolve(modulePath)];
  process.env.GEMINI_API_KEY = 'dummy-key-for-local-test';
  if (upstashConfigured) {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  let geminiWasCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('fake-upstash.example')) {
      if (upstashThrows) throw new Error('simulated Upstash network failure');
      return { ok: true, json: async () => ([{ result: simulatedCount }, { result: 1 }]) };
    }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiWasCalled = true;
      if (!geminiOk) {
        return { ok: false, status: geminiStatus, text: async () => geminiRawErrorText };
      }
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ phone: '01012345678' }) }] } }] }),
      };
    }
    throw new Error('unexpected fetch to ' + url);
  };

  const handler = require(modulePath);
  return { handler, getGeminiWasCalled: () => geminiWasCalled };
}

async function testEndpoint(modulePath, label, RATE_LIMIT_MAX) {
  // --- A: rate limiting ---
  {
    const { handler, getGeminiWasCalled } = await loadHandlerWithMocks(modulePath, { upstashConfigured: true, simulatedCount: 1 });
    const req = { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    check(`${label}: under-limit request reaches Gemini (200)`, res.statusCode === 200 && getGeminiWasCalled() === true);
  }
  {
    const { handler, getGeminiWasCalled } = await loadHandlerWithMocks(modulePath, { upstashConfigured: true, simulatedCount: RATE_LIMIT_MAX + 1 });
    const req = { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    check(`${label}: over-limit request blocked (429) and Gemini NEVER called`, res.statusCode === 429 && getGeminiWasCalled() === false);
  }
  {
    const { handler, getGeminiWasCalled } = await loadHandlerWithMocks(modulePath, { upstashConfigured: false, simulatedCount: 9999 });
    const req = { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    check(`${label}: missing Upstash config fails OPEN (200, Gemini called)`, res.statusCode === 200 && getGeminiWasCalled() === true);
  }
  {
    const { handler, getGeminiWasCalled } = await loadHandlerWithMocks(modulePath, { upstashConfigured: true, simulatedCount: 9999, upstashThrows: true });
    const req = { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    check(`${label}: Upstash outage fails OPEN (200, Gemini called)`, res.statusCode === 200 && getGeminiWasCalled() === true);
  }

  // --- B: API error privacy ---
  {
    const secret = 'INTERNAL_GEMINI_DIAGNOSTIC_TEXT_SHOULD_NEVER_LEAK';
    const { handler } = await loadHandlerWithMocks(modulePath, { upstashConfigured: true, simulatedCount: 1, geminiOk: false, geminiStatus: 502, geminiRawErrorText: secret });
    const req = { method: 'POST', headers: { 'x-forwarded-for': '5.6.7.8' }, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    const bodyStr = JSON.stringify(res.body || {});
    check(`${label}: upstream failure returns 502`, res.statusCode === 502);
    check(`${label}: raw upstream diagnostic text NEVER reaches the client response`, !bodyStr.includes(secret));
    check(`${label}: response body has no 'detail' key`, !Object.prototype.hasOwnProperty.call(res.body || {}, 'detail'));
  }
  {
    delete require.cache[require.resolve(modulePath)];
    delete process.env.GEMINI_API_KEY;
    const handler = require(modulePath);
    const req = { method: 'POST', headers: {}, body: { image: 'x'.repeat(50) } };
    const res = makeRes();
    await handler(req, res);
    const bodyStr = JSON.stringify(res.body || {});
    check(`${label}: missing-API-key response never names GEMINI_API_KEY`, !bodyStr.includes('GEMINI_API_KEY'));
    process.env.GEMINI_API_KEY = 'dummy-key-for-local-test';
  }
}

(async () => {
  const phonePath = path.join(__dirname, '..', 'api', 'extract-phone.js');
  const receiptPath = path.join(__dirname, '..', 'api', 'extract-receipt.js');
  await testEndpoint(phonePath, 'extract-phone', 30);
  await testEndpoint(receiptPath, 'extract-receipt', 15);

  console.log(`\n${passed}/${passed + failures} passing`);
  if (failures > 0) process.exit(1);
})();
