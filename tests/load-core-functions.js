// Phase 6 — loads the REAL accounting/settlement/duplicate-detection/navigation-guard
// functions straight out of the actual index.html via vm, so tests run against the exact
// shipped code. escapeHTML is stubbed only because it needs a real browser `document` —
// settlementBreakdownHTML's use of it is not itself an accounting invariant, so a plain
// String() stand-in is sufficient here (escapeHTML's own correctness was verified by
// manual code review: it uses the standard textContent->innerHTML browser-escaping
// pattern, and every call site in index.html was checked to use it correctly for
// AI/user-provided text placed into innerHTML).
const vm = require('vm');
const { readIndexHtml, sliceBetween, extractFunction } = require('./extract');

const html = readIndexHtml();

const engineSlice = sliceBetween(
  html,
  '// Phase 3 — Shift Accounting: pure calculation engine',
  '// ---------- Orders view (compact list + search) ----------'
);

const canLeaveScanTabSrc = extractFunction(html, 'canLeaveScanTab');
const csvFieldSrc = extractFunction(html, 'csvField');

const sandbox = {
  escapeHTML: (s) => String(s == null ? '' : s),
  console,
};
vm.createContext(sandbox);
vm.runInContext(engineSlice + '\n' + canLeaveScanTabSrc + '\n' + csvFieldSrc, sandbox);

module.exports = sandbox;
