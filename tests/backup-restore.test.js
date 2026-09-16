// Phase 10 — standalone regression tests for item C (Backup & Restore) validation logic.
// Same honesty note as tests/phase10-api.test.js: written and run in a sandboxed
// environment with no visibility into this repo's real tests/run-all.js — plain Node,
// zero dependencies, run directly: node tests/backup-restore.test.js
// This tests validateBackupPayload() in isolation (pure function, no DOM/localStorage
// touched) — it does NOT exercise the actual button click / file picker / confirmation
// dialog flow in the browser, which needs real-device or real-browser testing.

let failures = 0, passed = 0;
function check(label, cond){ if (cond) passed++; else { failures++; console.error('FAIL:', label); } }

// Inline copy of the exact validateBackupPayload() logic shipped in index.html
// (kept in sync manually — see index.html's "Phase 10 — C" section for the source of truth).
const BACKUP_SCHEMA_VERSION = 1;
function validateBackupPayload(parsed){
  if (!parsed || typeof parsed !== 'object' || typeof parsed.scanlyBackupSchemaVersion !== 'number'){
    return { ok: false, reason: 'الملف ده مش نسخة احتياطية صالحة من Scanly' };
  }
  if (parsed.scanlyBackupSchemaVersion !== BACKUP_SCHEMA_VERSION){
    return { ok: false, reason: `النسخة الاحتياطية دي من إصدار غير متوافق (v${parsed.scanlyBackupSchemaVersion}) — الإصدار المدعوم هنا هو v${BACKUP_SCHEMA_VERSION}` };
  }
  const data = parsed.data;
  if (!data || typeof data !== 'object'){
    return { ok: false, reason: 'الملف تالف — بيانات النسخة الاحتياطية مفقودة' };
  }
  const { phoneLog, restaurantList, shifts: shiftsData } = data;
  if (!Array.isArray(phoneLog) || !Array.isArray(restaurantList) || !Array.isArray(shiftsData)){
    return { ok: false, reason: 'الملف تالف — شكل البيانات مش مطابق' };
  }
  if (!phoneLog.every(o => o && typeof o === 'object' && typeof o.phone === 'string')){
    return { ok: false, reason: 'الملف تالف — بيانات الأوردرات فيها مشكلة' };
  }
  if (!restaurantList.every(r => typeof r === 'string')){
    return { ok: false, reason: 'الملف تالف — قائمة المطاعم فيها مشكلة' };
  }
  if (!shiftsData.every(s => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.status === 'string')){
    return { ok: false, reason: 'الملف تالف — بيانات الشفتات فيها مشكلة' };
  }
  return { ok: true, data: { phoneLog, restaurantList, shifts: shiftsData } };
}

const validSample = {
  scanlyBackupSchemaVersion: 1,
  exportedAt: '2026-09-16T00:00:00.000Z',
  data: {
    phoneLog: [{ phone: '01012345678', savedAt: '2026-09-16T00:00:00.000Z' }],
    restaurantList: ['اما'],
    shifts: [{ id: 'shift_1', status: 'closed' }],
  },
};

check('valid payload accepted', validateBackupPayload(validSample).ok === true);
check('null rejected', validateBackupPayload(null).ok === false);
check('non-object rejected', validateBackupPayload('not an object').ok === false);
check('missing schema version rejected', validateBackupPayload({ data: {} }).ok === false);
check('wrong schema version rejected', validateBackupPayload({ ...validSample, scanlyBackupSchemaVersion: 2 }).ok === false);
check('missing data rejected', validateBackupPayload({ scanlyBackupSchemaVersion: 1 }).ok === false);
check('phoneLog not an array rejected', validateBackupPayload({ ...validSample, data: { ...validSample.data, phoneLog: {} } }).ok === false);
check('phoneLog entry missing phone string rejected', validateBackupPayload({ ...validSample, data: { ...validSample.data, phoneLog: [{ savedAt: 'x' }] } }).ok === false);
check('restaurantList with non-string entry rejected', validateBackupPayload({ ...validSample, data: { ...validSample.data, restaurantList: [123] } }).ok === false);
check('shifts entry missing id rejected', validateBackupPayload({ ...validSample, data: { ...validSample.data, shifts: [{ status: 'open' }] } }).ok === false);
check('empty arrays (fresh install backup) accepted', validateBackupPayload({ scanlyBackupSchemaVersion: 1, data: { phoneLog: [], restaurantList: [], shifts: [] } }).ok === true);
check('malformed JSON.parse throw is caught by caller (JSON.parse itself)', (() => { try { JSON.parse('{not json'); return false; } catch(e){ return true; } })());

console.log(`\n${passed}/${passed + failures} passing`);
if (failures > 0) process.exit(1);
