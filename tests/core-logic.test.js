// Phase 6 — minimal committed regression suite for Scanly's core, DOM-free invariants.
// Run with: node tests/core-logic.test.js
// This is intentionally small and focused (per the Phase 6 instruction to add only the
// minimum necessary tests): it protects the specific things a future edit could break
// silently and expensively — accounting completeness/lock math, settlement totals,
// duplicate-phone normalization/scoping, and the Phase 6 editing-navigation guard.
// It does NOT attempt to simulate the DOM/UI layer — those paths are covered by manual
// code review plus real-device QA (see the Phase 6 final report for what was and wasn't
// covered this way).

const assert = require('assert');
const fns = require('./load-core-functions');

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

console.log('\n== isAccountingComplete() ==');
test('cash order with valid price+fee is complete', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 100, fee: 15 }), true);
});
test('visa order requires price === 0 exactly', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'visa', price: 0, fee: 15 }), true);
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'visa', price: 5, fee: 15 }), false);
});
test('missing paymentType is incomplete (legacy/batch orders)', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: null, price: 100, fee: 15 }), false);
  assert.strictEqual(fns.isAccountingComplete({}), false);
  assert.strictEqual(fns.isAccountingComplete(null), false);
});
test('fee must be > 0 and <= 5000', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 50, fee: 0 }), false);
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 50, fee: 5000 }), true);
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 50, fee: 5001 }), false);
});
test('cash price must be > 0 and <= 50000', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 0, fee: 10 }), false);
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 50000, fee: 10 }), true);
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 50001, fee: 10 }), false);
});
test('fee > price is explicitly ALLOWED (not a business rule per project docs)', () => {
  assert.strictEqual(fns.isAccountingComplete({ paymentType: 'cash', price: 10, fee: 500 }), true);
});

console.log('\n== computeSettlement() ==');
test('zero orders -> all-zero settlement, averageProfit does not divide by zero', () => {
  const s = fns.computeSettlement([]);
  // JSON round-trip: `s` is a plain object from the vm sandbox's own realm, so its
  // Object.prototype differs (by identity) from this file's — deepStrictEqual treats
  // that as a mismatch even though every value is identical. Normalizing through JSON
  // keeps the comparison strict on values/types while sidestepping that realm artifact.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), { totalOrders: 0, cashInHand: 0, totalProfit: 0, averageProfit: 0, oweRestaurant: 0, owedByRestaurant: 0, net: 0 });
});
test('mixed cash/visa orders compute correct totals and net', () => {
  const orders = [
    { paymentType: 'cash', price: 200, fee: 20 },   // cashInHand+200, profit+20, owe += 180
    { paymentType: 'cash', price: 100, fee: 15 },   // cashInHand+100, profit+15, owe += 85
    { paymentType: 'visa', price: 0,   fee: 25 },   // profit+25, owedByRestaurant += 25
    { paymentType: null,   price: 999, fee: 999 },  // incomplete — must be fully excluded
  ];
  const s = fns.computeSettlement(orders);
  assert.strictEqual(s.totalOrders, 3);
  assert.strictEqual(s.cashInHand, 300);
  assert.strictEqual(s.totalProfit, 60);
  assert.strictEqual(s.oweRestaurant, 265);   // (200-20)+(100-15)
  assert.strictEqual(s.owedByRestaurant, 25);
  assert.strictEqual(s.net, 240);             // 265 - 25
  assert.strictEqual(s.averageProfit, 20);    // 60 / 3
});
test('incomplete orders are silently excluded from every sum, not just totalOrders', () => {
  const s = fns.computeSettlement([{ paymentType: 'cash', price: -5, fee: 10 }]);
  assert.strictEqual(s.totalOrders, 0);
  assert.strictEqual(s.cashInHand, 0);
});

console.log('\n== computeSettlementByRestaurant() ==');
test('groups by exact restaurant string, sorts by profit desc, drops empty groups', () => {
  const orders = [
    { restaurant: 'اما', paymentType: 'cash', price: 100, fee: 10 },
    { restaurant: 'اما', paymentType: 'cash', price: 100, fee: 10 },
    { restaurant: 'مطعم ب', paymentType: 'visa', price: 0, fee: 50 },
    { restaurant: null, paymentType: 'cash', price: 100, fee: 5 },       // -> NO_RESTAURANT_LABEL bucket
    { restaurant: 'فاضي بس مش محاسبي', paymentType: null, price: 1, fee: 1 }, // incomplete -> its group has 0 complete orders -> dropped
  ];
  const groups = fns.computeSettlementByRestaurant(orders);
  const names = groups.map(g => g.restaurant);
  assert.strictEqual(names.includes('فاضي بس مش محاسبي'), false, 'group with zero accounting-complete orders must be dropped');
  assert.strictEqual(groups[0].restaurant, 'مطعم ب', 'highest totalProfit (50) must sort first');
  assert.strictEqual(groups[0].settlement.totalProfit, 50);
  const amaGroup = groups.find(g => g.restaurant === 'اما');
  assert.strictEqual(amaGroup.settlement.totalOrders, 2);
  assert.strictEqual(amaGroup.settlement.totalProfit, 20);
});

console.log('\n== normalizePhoneForCompare() / duplicate detection ==');
test('accepts plain 11-digit Egyptian mobile', () => {
  assert.strictEqual(fns.normalizePhoneForCompare('01012345678'), '01012345678');
});
test('accepts +20 / 0020 / spaced / dashed formats, all normalize identically', () => {
  const expected = '01012345678';
  assert.strictEqual(fns.normalizePhoneForCompare('+20 10 1234 5678'), expected);
  assert.strictEqual(fns.normalizePhoneForCompare('0020 101 234 5678'), expected);
  assert.strictEqual(fns.normalizePhoneForCompare('010-1234-5678'), expected);
  assert.strictEqual(fns.normalizePhoneForCompare('20 1012345678'), expected); // 12-digit no + / 00
});
test('accepts Arabic-Indic and Persian digits', () => {
  assert.strictEqual(fns.normalizePhoneForCompare('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
  assert.strictEqual(fns.normalizePhoneForCompare('۰۱۰۱۲۳۴۵۶۷۸'), '01012345678');
});
test('rejects invalid Egyptian mobile prefixes / lengths / garbage', () => {
  assert.strictEqual(fns.normalizePhoneForCompare('01312345678'), null); // 013 not a valid prefix
  assert.strictEqual(fns.normalizePhoneForCompare('0101234567'), null);  // 10 digits
  assert.strictEqual(fns.normalizePhoneForCompare('hello'), null);
  assert.strictEqual(fns.normalizePhoneForCompare(null), null);
  assert.strictEqual(fns.normalizePhoneForCompare(12345), null); // non-string input
});

console.log('\n== hasDuplicatePhoneInShift() (uses module-level `log`) ==');
test('flags same phone within the same shiftId bucket', () => {
  fns.log = [{ phone: '01012345678', shiftId: 'shiftA' }];
  assert.strictEqual(fns.hasDuplicatePhoneInShift('010 1234 5678', 'shiftA', -1), true);
});
test('does NOT flag the same phone in a DIFFERENT shiftId', () => {
  fns.log = [{ phone: '01012345678', shiftId: 'shiftA' }];
  assert.strictEqual(fns.hasDuplicatePhoneInShift('01012345678', 'shiftB', -1), false);
});
test('null shiftId only matches other null-shiftId entries (shared bucket)', () => {
  fns.log = [{ phone: '01012345678', shiftId: null }];
  assert.strictEqual(fns.hasDuplicatePhoneInShift('01012345678', null, -1), true);
});
test('excludeIndex lets an edit skip comparing against its own prior copy', () => {
  fns.log = [{ phone: '01012345678', shiftId: 'shiftA' }];
  assert.strictEqual(fns.hasDuplicatePhoneInShift('01012345678', 'shiftA', 0), false);
});
test('invalid phone never flags a duplicate', () => {
  fns.log = [{ phone: '01012345678', shiftId: 'shiftA' }];
  assert.strictEqual(fns.hasDuplicatePhoneInShift('notaphone', 'shiftA', -1), false);
});

console.log('\n== canLeaveScanTab() — Phase 6 Release Blocker #1 fix ==');
test('switching to the same view is always allowed (no-op)', () => {
  assert.strictEqual(fns.canLeaveScanTab('scan', 'scan', 5, false), true);
});
test('guard only applies when currently ON the scan tab', () => {
  assert.strictEqual(fns.canLeaveScanTab('scan', 'orders', 5, false), true);
});
test('no active edit (editingIndex === null) -> always allowed to leave', () => {
  assert.strictEqual(fns.canLeaveScanTab('orders', 'scan', null, false), true);
});
test('active edit but the form is not actually visible -> allowed to leave', () => {
  assert.strictEqual(fns.canLeaveScanTab('orders', 'scan', 3, true), true);
});
test('THE FIX: active edit + form visible + leaving scan for another tab -> BLOCKED', () => {
  assert.strictEqual(fns.canLeaveScanTab('orders', 'scan', 3, false), false);
  assert.strictEqual(fns.canLeaveScanTab('more', 'scan', 0, false), false); // index 0 is falsy but must still block
});

console.log('\n== csvField() — Phase 6 CSV export escaping ==');
test('plain values pass through unquoted', () => {
  assert.strictEqual(fns.csvField('اما'), 'اما');
  assert.strictEqual(fns.csvField(''), '');
  assert.strictEqual(fns.csvField(null), '');
});
test('a value containing a comma gets quoted (prevents column-shift on import)', () => {
  assert.strictEqual(fns.csvField('مطعم, فرع 2'), '"مطعم, فرع 2"');
});
test('embedded quotes are doubled per RFC 4180', () => {
  assert.strictEqual(fns.csvField('قال "مرحبا"'), '"قال ""مرحبا"""');
});

console.log(`\n${pass} passed, ${fail} failed (core-logic.test.js)`);
process.exitCode = fail ? 1 : 0;

