'use strict';

// Stage 1 local acceptance gate. This is a deterministic wiring/coverage audit,
// not a substitute for the opt-in PostgreSQL and live staging/browser checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json'));
const checklist = read('NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md');
const audit = read('NETSHIFT_STATE_OWNERSHIP_AUDIT.md');
const plan = read('NETSHIFT_V2_IMPLEMENTATION_PLAN.md');
const checkpoint = read('NETSHIFT_STAGE1_CHUNK10_CHECKPOINT.md');
const pgTest = read('scripts/test-stage1-postgres.js');

const requiredScripts = [
  'scripts/check-stage1-migration-contract.js',
  'scripts/check-stage1-save-protocol.js',
  'scripts/check-stage1-client-save-protocol.js',
  'scripts/check-stage1-save-cutover.js',
  'scripts/check-stage1-hydration-gate.js',
  'scripts/check-stage1-canonical-inventory.js',
  'scripts/check-stage1-legacy-inventory-fence.js',
  'scripts/check-stage1-host-loot-regeneration.js',
  'scripts/check-stage1-host-download-claim.js'
];

for (const script of requiredScripts) {
  assert.ok(fs.existsSync(path.join(root, script)), `required Stage 1 regression script is missing: ${script}`);
  assert.ok(pkg.scripts.check.includes(`node ${script}`), `npm run check must execute ${script}`);
}
assert.ok(pkg.scripts.check.includes('node scripts/check-stage1-acceptance.js'), 'the Stage 1 acceptance audit must be part of npm run check');
assert.ok(pkg.scripts['test:stage1:postgres'] === 'node scripts/test-stage1-postgres.js', 'the opt-in PostgreSQL test command must be explicit');

// T1 — legacy cutover protects canonical data and retires stale save protocol.
const cutover = read('lib/legacy-save-cutover.js');
const saveProtocol = read('lib/save-protocol.js');
assert.ok(cutover.includes('netshift_migration_receipts'), 'legacy save cutover must be receipt/idempotency based');
assert.ok(cutover.includes('netshift_saves'), 'legacy save cutover must explicitly scope itself to save rows');
assert.ok(saveProtocol.includes('schemaVersion'), 'schema-v2 allowlist protocol must remain present');
assert.ok(!/DELETE\s+FROM\s+netshift_(users|player_world|bank_accounts|player_files|world_targets|world_host_inventory|world_loot_claims|admin_roles)/i.test(cutover), 'legacy save cutover must not delete canonical records');

// T2 — authenticated startup remains fail-closed until required hydration succeeds.
const client = read('public/index.html');
const server = read('server.js');
assert.ok(server.includes("require('./lib/legacy-save-cutover')"), 'server must wire the cutover service');
assert.ok(client.includes('NETSHIFT_HYDRATION_READY'), 'authenticated client must expose the hydration gate');
assert.ok(client.includes("'/api/core/files'"), 'client must refresh canonical Core files');

// T3 — canonical file views and signed-in legacy writer fence.
const fence = read('scripts/check-stage1-legacy-inventory-fence.js');
assert.ok(fence.includes('assert.'), 'legacy-fence test must contain executable assertions');
assert.ok(client.includes('authenticated'), 'client must retain an authenticated/offline mode boundary');

// T4 — atomic host claim and capped/weighted stock regeneration.
const claim = read('lib/host-download-claim.js');
const loot = read('lib/host-loot-regeneration.js');
for (const marker of ['BEGIN', 'COMMIT', 'ROLLBACK', 'FOR UPDATE', 'DOWNLOAD_NAME_CONFLICT']) {
  assert.ok(claim.includes(marker), `atomic host claim implementation is missing ${marker}`);
}
assert.ok(loot.includes('HOST_STOCK_LIMITS'), 'host loot stock limits must be explicit');
assert.ok(pgTest.includes('applyLegacySaveCutover'), 'PostgreSQL integration test must exercise the real legacy-save cutover helper');
assert.ok(pgTest.includes('CREATE SCHEMA'), 'PostgreSQL integration test must create an isolated schema');
assert.ok(pgTest.includes('DROP SCHEMA IF EXISTS'), 'PostgreSQL integration test must clean up only its isolated schema');
assert.ok(pgTest.includes('NETSHIFT_STAGE1_TEST_DATABASE_URL'), 'PostgreSQL tests must require a dedicated explicit URL');
assert.ok(!pgTest.includes('process.env.DATABASE_URL'), 'PostgreSQL tests must never silently fall back to the app DATABASE_URL');
assert.ok(pgTest.includes('I_CREATED_A_DISPOSABLE_DATABASE'), 'PostgreSQL test execution must require explicit disposable-database acknowledgement');
assert.ok(pgTest.includes('.onrender') && pgTest.includes('render\\.com'), 'PostgreSQL tests must refuse Render endpoints');

// T5/T6 — required evidence is documented, not silently marked as run.
for (const marker of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
  assert.ok(checklist.includes(marker), `staging acceptance checklist must document ${marker}`);
  assert.ok(audit.includes(marker), `state-ownership audit must record evidence mapping for ${marker}`);
}
assert.match(checklist, /NOT SIGNED OFF/i, 'checklist must state that Stage 1 is not signed off before runtime evidence');
assert.match(checkpoint, /PostgreSQL.*NOT RUN/i, 'checkpoint must explicitly record PostgreSQL status');
assert.match(checkpoint, /browser.*NOT RUN/i, 'checkpoint must explicitly record browser status');
assert.match(plan, /Stage 1 cannot be declared complete before this gate/i, 'release plan must retain the final acceptance gate');

console.log('Stage 1 acceptance gate OK: T1 save/cutover, T2 auth/hydration, T3 canonical inventory/fence, T4 host claim/loot, T5 isolation/security evidence, T6 release sign-off.');
console.log('Scope note: this is static wiring/coverage validation only; it does not assert that PostgreSQL or live staging tests have passed.');
