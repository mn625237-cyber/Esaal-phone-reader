// Phase 6 — small static/config regression checks. These guard against accidental
// future drift on two Phase 6 fixes that aren't expressible as pure-function unit tests
// (deployment config JSON, and a CSS rule).
// Run with: node tests/static-checks.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn){
  try{
    fn();
    pass++;
    console.log('  ✅', name);
  }catch(e){
    fail++;
    console.log('  ❌', name, '—', e.message);
  }
}

console.log('\n== vercel.json ==');
test('is valid JSON', () => {
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
});
test('both Gemini endpoints have maxDuration: 30 (parity, Phase 6 fix)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.strictEqual(cfg.functions['api/extract-phone.js'].maxDuration, 30);
  assert.strictEqual(cfg.functions['api/extract-receipt.js'].maxDuration, 30);
});
test('the pre-existing /share-target redirect is untouched', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepStrictEqual(cfg.redirects, [{ source: '/share-target', destination: '/', statusCode: 303 }]);
});

console.log('\n== index.html CSS ==');
test('.chip has a 44px minimum touch target (Phase 6 fix)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/\.chip\{([^}]*)\}/);
  assert.ok(m, '.chip rule not found');
  assert.ok(/min-height:\s*44px/.test(m[1]), '.chip rule missing min-height: 44px');
});

console.log('\n== api key boundary ==');
test('GEMINI_API_KEY never appears in index.html (frontend)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!html.includes('GEMINI_API_KEY'));
});
test('both API files still read the key only from process.env (server-side)', () => {
  const phoneJs = fs.readFileSync(path.join(__dirname, '..', 'api', 'extract-phone.js'), 'utf8');
  const receiptJs = fs.readFileSync(path.join(__dirname, '..', 'api', 'extract-receipt.js'), 'utf8');
  assert.ok(phoneJs.includes('process.env.GEMINI_API_KEY'));
  assert.ok(receiptJs.includes('process.env.GEMINI_API_KEY'));
});

console.log(`\n${pass} passed, ${fail} failed (static-checks.test.js)`);
process.exitCode = fail ? 1 : 0;
