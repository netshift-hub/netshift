'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CURRENT_SAVE_SCHEMA_VERSION,
  MAX_SAVE_REVISION,
  normaliseStoredSave,
  validateSaveRequest
} = require('../lib/save-protocol');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function accepted(payload) {
  const result = validateSaveRequest(payload);
  assert.equal(result.ok, true, result.error);
  return result;
}
function rejected(payload, code) {
  const result = validateSaveRequest(payload);
  assert.equal(result.ok, false, 'payload should be rejected');
  if (code) assert.equal(result.code, code);
  return result;
}

function testValidPreferencesOnlyPayload() {
  assert.equal(CURRENT_SAVE_SCHEMA_VERSION, 2);
  const result = accepted({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: ' WHOIS.COM ' } });
  assert.equal(result.baseRevision, 0);
  assert.deepEqual(result.save, { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } });
  assert.deepEqual(accepted({ schemaVersion: 2, baseRevision: 3, preferences: {} }).save,
    { schemaVersion: 2, preferences: {} });
  assert.deepEqual(accepted({ schemaVersion: 2, baseRevision: 4, preferences: { lastAddress: 'bank-info://local' } }).save,
    { schemaVersion: 2, preferences: { lastAddress: 'bank-info://local' } });
}

function testProtectedAndUnknownFieldsAreRejected() {
  rejected({ schemaVersion: 1, baseRevision: 0, state: { owned: ['forged'] } }, 'SAVE_SCHEMA_UNSUPPORTED');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: 'whois.com' }, state: { owned: ['forged'] } }, 'SAVE_FIELDS_NOT_ALLOWED');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: 'whois.com' }, client: { address: 'whois.com' } }, 'SAVE_FIELDS_NOT_ALLOWED');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { balance: 999999 } }, 'SAVE_PREFERENCES_INVALID');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { inventory: ['firewall6'] } }, 'SAVE_PREFERENCES_INVALID');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: 'javascript:alert(1)' } }, 'SAVE_PREFERENCES_INVALID');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: 'whois.com\nstate' } }, 'SAVE_PREFERENCES_INVALID');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: { lastAddress: 'x'.repeat(254) } }, 'SAVE_PREFERENCES_INVALID');
}

function testShapeAndRevisionValidation() {
  for (const payload of [null, [], 'v2', 2]) rejected(payload, 'SAVE_PAYLOAD_INVALID');
  for (const revision of [-1, 1.5, '0', null, MAX_SAVE_REVISION + 1, Number.MAX_SAFE_INTEGER]) {
    rejected({ schemaVersion: 2, baseRevision: revision, preferences: {} }, 'SAVE_REVISION_INVALID');
  }
  rejected({ schemaVersion: 3, baseRevision: 0, preferences: {} }, 'SAVE_SCHEMA_UNSUPPORTED');
  rejected({ schemaVersion: 2, baseRevision: 0 }, 'SAVE_PREFERENCES_INVALID');
  rejected({ schemaVersion: 2, baseRevision: 0, preferences: [] }, 'SAVE_PREFERENCES_INVALID');
}

function testStoredSaveNeverLeaksProtectedState() {
  assert.deepEqual(normaliseStoredSave({ schemaVersion: 2, preferences: { lastAddress: 'WHOIS.COM' } }),
    { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } });
  assert.deepEqual(normaliseStoredSave({ schemaVersion: 2, preferences: {} }),
    { schemaVersion: 2, preferences: {} });
  assert.equal(normaliseStoredSave({ schemaVersion: 1, state: { owned: ['legacy'] } }), null);
  assert.equal(normaliseStoredSave({ schemaVersion: 2, preferences: {}, state: { owned: ['forged'] } }), null);
  assert.equal(normaliseStoredSave({ schemaVersion: 2, preferences: { balance: 9999 } }), null);
}

function testServerWriterContract() {
  const saveStart = server.indexOf("app.post('/api/save', requireAuth, saveLimiter");
  const coreStart = server.indexOf('// NETSHIFT Core v2 APIs.', saveStart);
  const route = server.slice(saveStart, coreStart);
  assert.ok(saveStart >= 0 && coreStart > saveStart, 'save route should be identifiable');
  assert.ok(server.includes("require('./lib/save-protocol')"), 'server must use the dedicated save protocol module');
  assert.ok(server.includes('normaliseStoredSave(row.save_data)'), 'GET must validate stored save data before returning it');
  assert.ok(route.includes('validateSaveRequest(payload)'), 'POST must validate a strict save allowlist');
  assert.ok(route.includes('SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE'), 'POST must re-check session ownership under lock');
  assert.ok(route.includes('BEGIN') && route.includes('COMMIT') && route.includes('ROLLBACK'), 'save mutation must be transactional');
  assert.ok(/ON CONFLICT \(user_id\) DO NOTHING/i.test(route), 'first save must not overwrite an existing row when baseRevision is zero');
  assert.ok(/WHERE user_id = \$1 AND revision = \$3/i.test(route), 'updates must compare the base revision');
  assert.ok(route.includes('currentRevision'), 'success and conflict responses should expose the current revision');
  assert.ok(!route.includes("code: 'SAVE_PROTOCOL_NOT_READY'"), 'schema-v2 allowlisted save protocol should be enabled');
  assert.ok(packageJson.scripts.check.includes('check-stage1-save-protocol.js'), 'the protocol checks must run under npm run check');
}

(async () => {
  testValidPreferencesOnlyPayload();
  testProtectedAndUnknownFieldsAreRejected();
  testShapeAndRevisionValidation();
  testStoredSaveNeverLeaksProtectedState();
  testServerWriterContract();
  console.log('Stage 1 save protocol checks OK (allowlist, protected-field rejection, stored-save sanitisation and revision contract).');
  console.log('Note: these tests do not replace PostgreSQL integration or browser tests.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
