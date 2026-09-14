// Phase 6 — regression tests for the two real serverless handlers, loaded via plain
// require() (they are already valid CommonJS modules — no source modification needed
// for this). Network is mocked via global.fetch so these run with no network access and
// never touch the real Gemini API; everything else (normalizePhone, sanitization,
// malformed-JSON handling, the new Phase 6 payload-size guard) runs as actually shipped.
// Run with: node tests/api-endpoints.test.js

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
async function test(name, fn){
  try{
    await fn();
    pass++;
    console.log('  ✅', name);
  }catch(e){
    fail++;
    console.log('  ❌', name, '—', e.message);
  }
}

function makeRes(){
  return {
    statusCode: null,
    body: null,
    status(code){ this.statusCode = code; return this; },
    json(obj){ this.body = obj; return this; },
  };
}

function geminiTextResponse(jsonPayload){
  // Mimics the real Gemini response shape both handlers read from:
  // data.candidates[0].content.parts[0].text
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(jsonPayload) }] } }],
    }),
  };
}

async function withMockFetch(response, fn){
  const original = global.fetch;
  let called = false;
  global.fetch = async (...args) => { called = true; return typeof response === 'function' ? response(...args) : response; };
  try{
    await fn(() => called);
  } finally {
    global.fetch = original;
  }
}

(async () => {
  process.env.GEMINI_API_KEY = 'test-key-for-regression-suite';
  const extractPhone = require(path.join(__dirname, '..', 'api', 'extract-phone.js'));
  const extractReceipt = require(path.join(__dirname, '..', 'api', 'extract-receipt.js'));

  console.log('\n== api/extract-phone.js ==');

  await test('rejects non-POST with 405', async () => {
    const res = makeRes();
    await extractPhone({ method: 'GET' }, res);
    assert.strictEqual(res.statusCode, 405);
  });

  await test('rejects missing image with 400', async () => {
    const res = makeRes();
    await extractPhone({ method: 'POST', body: {} }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('rejects non-string image with 400', async () => {
    const res = makeRes();
    await extractPhone({ method: 'POST', body: { image: 12345 } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('Phase 6 payload-size guard: oversized image -> 413, Gemini never called', async () => {
    await withMockFetch(geminiTextResponse({ phone: '01012345678' }), async (wasCalled) => {
      const res = makeRes();
      const huge = 'a'.repeat(8 * 1024 * 1024 + 1);
      await extractPhone({ method: 'POST', body: { image: huge } }, res);
      assert.strictEqual(res.statusCode, 413);
      assert.strictEqual(wasCalled(), false, 'fetch must never be called once the size guard rejects the request');
    });
  });

  await test('normal +20-format phone from Gemini is normalized to 01XXXXXXXXX', async () => {
    await withMockFetch(geminiTextResponse({ phone: '+20 10 1234 5678' }), async () => {
      const res = makeRes();
      await extractPhone({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.phone, '01012345678');
    });
  });

  await test('invalid phone from Gemini normalizes to null (never passed through raw)', async () => {
    await withMockFetch(geminiTextResponse({ phone: '123' }), async () => {
      const res = makeRes();
      await extractPhone({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.phone, null);
    });
  });

  await test('malformed JSON from Gemini fails closed (regex fallback or null), never throws', async () => {
    await withMockFetch({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] }),
    }, async () => {
      const res = makeRes();
      await extractPhone({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.phone, null);
    });
  });

  await test('Gemini HTTP failure surfaces as 502', async () => {
    await withMockFetch({ ok: false, text: async () => 'upstream error detail' }, async () => {
      const res = makeRes();
      await extractPhone({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 502);
    });
  });

  console.log('\n== api/extract-receipt.js ==');

  await test('rejects non-POST with 405', async () => {
    const res = makeRes();
    await extractReceipt({ method: 'GET' }, res);
    assert.strictEqual(res.statusCode, 405);
  });

  await test('Phase 6 payload-size guard: oversized image -> 413, Gemini never called', async () => {
    await withMockFetch(geminiTextResponse({ phone: null, building: null, floor: null, apt: null, restaurant: null, area: null, payment: null, paymentHint: { type: null, amountText: null } }), async (wasCalled) => {
      const res = makeRes();
      const huge = 'a'.repeat(8 * 1024 * 1024 + 1);
      await extractReceipt({ method: 'POST', body: { image: huge } }, res);
      assert.strictEqual(res.statusCode, 413);
      assert.strictEqual(wasCalled(), false);
    });
  });

  await test('full 8-field extraction: sanitizes, trims, and normalizes correctly', async () => {
    const payload = {
      phone: '01212345678',
      building: '  12  ',
      floor: '3',
      apt: null,
      restaurant: 'مطعم الاختبار',
      area: 'المعادي',
      payment: 'فيزا',
      paymentHint: { type: 'visa', amountText: '275 ج' },
    };
    await withMockFetch(geminiTextResponse(payload), async () => {
      const res = makeRes();
      await extractReceipt({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.phone, '01212345678');
      assert.strictEqual(res.body.building, '12'); // sanitizeSuggestedText trims
      assert.strictEqual(res.body.area, 'المعادي');
      assert.deepStrictEqual(res.body.paymentHint, { type: 'visa', amountText: '275 ج' });
    });
  });

  await test('oversized suggested text field is truncated, not rejected', async () => {
    const longName = 'ر'.repeat(200);
    await withMockFetch(geminiTextResponse({ phone: null, building: null, floor: null, apt: null, restaurant: longName, area: null, payment: null, paymentHint: { type: null, amountText: null } }), async () => {
      const res = makeRes();
      await extractReceipt({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.body.restaurant.length, 120);
    });
  });

  await test('invalid paymentHint.type falls back to null (unclear/garbage rejected)', async () => {
    await withMockFetch(geminiTextResponse({ phone: null, building: null, floor: null, apt: null, restaurant: null, area: null, payment: null, paymentHint: { type: 'bitcoin', amountText: 'x' } }), async () => {
      const res = makeRes();
      await extractReceipt({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.body.paymentHint.type, null);
    });
  });

  await test('malformed JSON fails closed to an all-null result, never throws', async () => {
    await withMockFetch({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"phone": truncated garbage' }] } }] }),
    }, async () => {
      const res = makeRes();
      await extractReceipt({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.phone, null);
      assert.strictEqual(res.body.restaurant, null);
      assert.deepStrictEqual(res.body.paymentHint, { type: null, amountText: null });
    });
  });

  console.log('\n== parity: both endpoints normalize phones identically ==');
  await test('extract-phone.js and extract-receipt.js agree on a battery of formats', async () => {
    const cases = ['+20 12 3456 7890', '00201012345678', '01512345678', '013123456789', 'nonsense', '٠١٠١٢٣٤٥٦٧٨'];
    for (const raw of cases){
      let phoneResult, receiptResult;
      await withMockFetch(geminiTextResponse({ phone: raw }), async () => {
        const res = makeRes();
        await extractPhone({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
        phoneResult = res.body.phone;
      });
      await withMockFetch(geminiTextResponse({ phone: raw, building: null, floor: null, apt: null, restaurant: null, area: null, payment: null, paymentHint: { type: null, amountText: null } }), async () => {
        const res = makeRes();
        await extractReceipt({ method: 'POST', body: { image: 'ZmFrZQ==' } }, res);
        receiptResult = res.body.phone;
      });
      assert.strictEqual(phoneResult, receiptResult, `mismatch for raw input "${raw}": phone.js=${phoneResult} receipt.js=${receiptResult}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed (api-endpoints.test.js)`);
  process.exitCode = fail ? 1 : 0;
})();
