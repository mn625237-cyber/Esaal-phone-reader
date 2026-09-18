// Phase 6 — runs the full committed regression suite in one command:
//   node tests/run-all.js
// Exits non-zero if any suite fails (so this can be wired into CI later if wanted —
// no CI system exists yet, this just makes that possible).
const { execFileSync } = require('child_process');
const path = require('path');

const suites = ['core-logic.test.js', 'api-endpoints.test.js', 'static-checks.test.js', 'upstash-rate-limit.test.js'];
let failed = false;

for (const suite of suites){
  console.log(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}`);
  try{
    execFileSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  }catch(e){
    failed = true;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed ? 'REGRESSION SUITE: FAILED' : 'REGRESSION SUITE: ALL PASSING');
process.exitCode = failed ? 1 : 0;
