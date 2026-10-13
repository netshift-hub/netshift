'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function section(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section found: ${startMarker}`);
  return html.slice(start, end);
}

const pureHelpers = section(
  'function netshiftIsValidPreferenceAddress(value) {',
  'async function netshiftSave('
);
const restoreFunction = section(
  'function netshiftRestoreSave(snapshot) {',
  'async function netshiftAfterAuth(user) {'
);
const testRuntime = new Function('$', 'state', 'go', 'console', `${pureHelpers}\n${restoreFunction}\nreturn { netshiftSnapshot, netshiftFingerprint, netshiftSaveRevisionFrom, netshiftRestoreSave, netshiftIsValidPreferenceAddress };`);

function makeRuntime(address) {
  const navigations = [];
  const state = { browserSurfacesV16: [{ primary: true, active: { address } }] };
  const $ = id => id === 'address' ? { value: address } : null;
  const go = (value, addHistory) => navigations.push({ value, addHistory });
  return { api: testRuntime($, state, go, console), navigations, state };
}

function testSnapshotIsPreferencesOnly() {
  const { api } = makeRuntime('WHOIS.COM');
  const snapshot = api.netshiftSnapshot();
  assert.deepEqual(snapshot, { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } });
  assert.equal(Object.hasOwn(snapshot, 'state'), false);
  assert.equal(Object.hasOwn(snapshot, 'client'), false);
  assert.equal(Object.hasOwn(snapshot, 'savedAt'), false);
  assert.equal(Object.hasOwn(snapshot, 'baseRevision'), false);
}

function testPreferenceAddressValidation() {
  const { api } = makeRuntime('whois.com');
  for (const address of ['whois.com', '127.123.45.67', 'router://admin', 'bank-info://local', 'ftpcash://local']) {
    assert.equal(api.netshiftIsValidPreferenceAddress(address), true, `${address} should be accepted`);
  }
  for (const address of ['', 'javascript:alert(1)', 'whois.com/path', 'whois.com\nstate', 'x'.repeat(254)]) {
    assert.equal(api.netshiftIsValidPreferenceAddress(address), false, `${JSON.stringify(address)} should be rejected`);
  }
}

function testFingerprintAndRevisionHandling() {
  const { api } = makeRuntime('whois.com');
  const payload = { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } };
  assert.equal(api.netshiftFingerprint({ ...payload, baseRevision: 1 }), api.netshiftFingerprint({ ...payload, baseRevision: 99 }));
  assert.equal(api.netshiftSaveRevisionFrom({ currentRevision: 7, revision: 6 }, 0), 7);
  assert.equal(api.netshiftSaveRevisionFrom({ revision: 4 }, 0), 4);
  assert.equal(api.netshiftSaveRevisionFrom({ currentRevision: -2 }, 5), 5);
}

function testRestoreOnlyAcceptsSchemaV2Preferences() {
  const { api, navigations } = makeRuntime('whois.com');
  assert.equal(api.netshiftRestoreSave({ schemaVersion: 2, preferences: { lastAddress: 'bank-info://local' } }), true);
  assert.deepEqual(navigations.pop(), { value: 'bank-info://local', addHistory: false });
  assert.equal(api.netshiftRestoreSave({ schemaVersion: 1, state: { owned: ['forged'] } }), false);
  assert.equal(api.netshiftRestoreSave({ schemaVersion: 2, preferences: { balance: 999999 } }), false);
  assert.equal(api.netshiftRestoreSave({ schemaVersion: 2, preferences: { lastAddress: 'whois.com' }, state: { owned: ['forged'] } }), false);
  assert.equal(api.netshiftRestoreSave({ schemaVersion: 2, preferences: { lastAddress: 'javascript:alert(1)' } }), false);
}

function testSavePathsUseOnlyV2Snapshot() {
  const save = section('async function netshiftSave(', 'function cloudSaveNow()');
  const auth = section('async function netshiftAfterAuth(user) {', 'function netshiftStartSessionHeartbeat()');
  const pageHide = section('window.addEventListener("pagehide"', '(async function netshiftInitialiseAuth()');
  const conflict = section('async function netshiftResolveSaveConflict()', 'function netshiftWorldSetConnection');
  assert.ok(save.includes('snapshot.baseRevision = NETSHIFT_SAVE_REVISION'));
  assert.ok(save.includes('body: JSON.stringify(snapshot)'));
  assert.ok(save.includes('NETSHIFT_LAST_SAVED_FINGERPRINT === "__save_read_failed__"'), 'failed initial read blocks save attempts');
  assert.ok(save.includes('if (!NETSHIFT_PREFERENCES_READY)'), 'saving is blocked until initial preferences/revision are ready');
  assert.ok(auth.includes('netshiftResetGameState()'), 'login resets legacy/transient game state');
  assert.ok(auth.includes('NETSHIFT_PREFERENCES_READY = !readFailed'), 'save readiness depends on successful initial preference read');
  assert.ok(!auth.includes('netshiftDeepMerge'), 'login never merges client-originated saved gameplay state');
  assert.ok(pageHide.includes('JSON.stringify(snapshot)'), 'pagehide sends the preferences-only snapshot');
  assert.ok(pageHide.includes('!NETSHIFT_PREFERENCES_READY'), 'pagehide refuses to send before initial revision is known');
  assert.ok(pageHide.includes('netshiftSaveRevisionFrom(result'), 'pagehide records canonical server revision');
  assert.ok(conflict.includes('netshiftRestoreSave(result.save)'), 'conflict resolution restores preferences only');
  assert.ok(!html.includes('function netshiftDeepMerge('), 'legacy whole-state merge helper is removed');
  assert.ok(html.includes('Save preferences'), 'save button describes what is persisted');
}

testSnapshotIsPreferencesOnly();
testPreferenceAddressValidation();
testFingerprintAndRevisionHandling();
testRestoreOnlyAcceptsSchemaV2Preferences();
testSavePathsUseOnlyV2Snapshot();
console.log('Stage 1 client save protocol checks OK (v2 preference payload, restore, revision, conflict and page-hide paths).');
