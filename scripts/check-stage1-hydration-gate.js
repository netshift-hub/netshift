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

const profileValidator = section(
  'function netshiftValidateCoreProfile(profile) {',
  'async function netshiftCoreLoadProfile('
);
const fileValidator = section(
  'function netshiftValidateCoreFileRows(rows, label) {',
  'async function netshiftCoreLoadFiles('
);
const validators = new Function(
  `${profileValidator}\n${fileValidator}\nreturn { netshiftValidateCoreProfile, netshiftValidateCoreFileRows };`
)();

function testProfileResponseValidation() {
  assert.equal(validators.netshiftValidateCoreProfile({
    ip: '172.123.45.67', safetyShield: true, bankSetup: false, bank: {}
  }), true);
  assert.equal(validators.netshiftValidateCoreProfile(null), false);
  assert.equal(validators.netshiftValidateCoreProfile({
    ip: '172.123.45.67', safetyShield: 'true', bankSetup: false, bank: {}
  }), false);
  assert.equal(validators.netshiftValidateCoreProfile({
    ip: '', safetyShield: true, bankSetup: false, bank: {}
  }), false);
  assert.equal(validators.netshiftValidateCoreProfile({
    ip: '172.123.45.67', safetyShield: true, bankSetup: false, bank: []
  }), false);
}

function testInventoryResponseValidation() {
  assert.deepEqual(validators.netshiftValidateCoreFileRows([], 'active files'), []);
  assert.equal(validators.netshiftValidateCoreFileRows([
    { id: 'id-1', name: 'readme.txt', parent_path: '/', item_type: 'file' },
    { id: 'id-2', name: 'downloads', parent_path: '/', item_type: 'folder' },
    { id: 'id-3', name: 'Firewall L1.exe', parent_path: '/desktop', item_type: 'software' }
  ], 'active files').length, 3);
  assert.throws(() => validators.netshiftValidateCoreFileRows(null, 'active files'), /invalid active files list/);
  assert.throws(() => validators.netshiftValidateCoreFileRows([
    { id: 'id-1', name: '', parent_path: '/', item_type: 'file' }
  ], 'active files'), /invalid record/);
  assert.throws(() => validators.netshiftValidateCoreFileRows([
    { id: 'same', name: 'a.txt', parent_path: '/', item_type: 'file' },
    { id: 'same', name: 'b.txt', parent_path: '/', item_type: 'file' }
  ], 'active files'), /duplicate record/);
}

function testRequiredHydrationGateAndRetry() {
  const auth = section('async function netshiftAfterAuth(user) {', 'function netshiftStartSessionHeartbeat()');
  assert.ok(auth.includes('netshiftCoreLoadProfile({ quiet: true, required: true })'), 'profile is a required load');
  assert.ok(auth.includes('netshiftCoreLoadFiles({ quiet: true, required: true })'), 'active files and Recycle Bin are required loads');
  assert.ok(auth.indexOf('netshiftCoreLoadProfile({ quiet: true, required: true })') < auth.indexOf('netshiftCoreLoadFiles({ quiet: true, required: true })'), 'profile is validated before file hydration');
  assert.ok(auth.indexOf('netshiftCoreLoadFiles({ quiet: true, required: true })') < auth.indexOf('netshiftCompleteHydration(user)'), 'game is unlocked only after required loaders');
  assert.ok(auth.includes('netshiftShowHydrationGate(') && auth.includes('{ retryable: true, failed: true }'), 'failed hydration shows a retryable blocking error');
  assert.ok(auth.includes('if (!NETSHIFT_PROFILE_READY || !NETSHIFT_FILES_READY)'), 'both readiness flags are checked before unlock');
  assert.ok(auth.includes('if (attempt !== NETSHIFT_HYDRATION_ATTEMPT'), 'stale in-flight hydration cannot unlock a changed session');
  assert.ok(html.includes('async function netshiftApiWithTimeout(') && html.includes('required ? netshiftApiWithTimeout'), 'required reads have a bounded timeout');

  const loader = section('function netshiftValidateCoreFileRows(rows, label) {', 'function netshiftCoreTakenName(');
  assert.ok(loader.includes('if (required) throw error'), 'required file hydration propagates errors instead of returning an empty inventory');
  assert.ok(loader.includes('return NETSHIFT_CORE_FILES;'), 'optional refresh failure retains the last confirmed inventory mirror');
  assert.ok(loader.includes('if (!Array.isArray(rows)) throw new Error'), 'malformed list responses are rejected');
  assert.ok(loader.includes('A canonical file appeared in both active inventory and the Recycle Bin'), 'cross-list duplicate IDs are rejected');
  assert.ok(loader.includes('state.localFiles = previous.localFiles'), 'failed mapping/rendering restores previous mirrors');
  assert.ok(loader.includes('requestedAttempt !== NETSHIFT_HYDRATION_ATTEMPT'), 'stale inventory requests cannot mutate a changed session');
  assert.ok(loader.includes('if (!stillOwnsSession)'), 'stale requests cannot roll back a newer account cache');

  const profileLoader = section('function netshiftValidateCoreProfile(profile) {', 'function netshiftCoreShieldDialog(');
  assert.ok(profileLoader.includes('if (required) throw e'), 'required profile reads propagate failures');
  assert.ok(profileLoader.includes('netshiftValidateCoreProfile(data?.profile)'), 'profile response schema is checked');
  assert.ok(profileLoader.includes('requestedAttempt !== NETSHIFT_HYDRATION_ATTEMPT'), 'stale profile responses cannot overwrite a changed session');

  const controls = section('<div id="authOverlay"', '</div>\n<div id="sessionHandoffOverlay"');
  assert.ok(controls.includes('id="hydrationRetryButton"'), 'retry control exists');
  assert.ok(controls.includes('id="hydrationSignOutButton"'), 'sign-out escape exists after failure');
  assert.ok(html.includes('function netshiftRetryHydration()'), 'retry handler exists');
  assert.ok(html.includes('function netshiftCompleteHydration(user)'), 'success path unlocks account only after hydration');
}

function testGameplayTimersPauseDuringHydration() {
  const helper = section('function netshiftGuardGameplayTimer(callback) {', 'const money =');
  const factory = new Function('window', `${helper}\nlet NETSHIFT_HYDRATION_READY = false; return { wrap: netshiftGuardGameplayTimer, setReady(value) { NETSHIFT_HYDRATION_READY = value; } };`);
  const fakeWindow = { NETSHIFT_USER: { id: 'user-a' } };
  const runtime = factory(fakeWindow);
  let calls = 0;
  const callback = runtime.wrap(() => { calls++; });
  callback();
  assert.equal(calls, 0, 'authenticated but unhydrated account pauses gameplay timer');
  runtime.setReady(true);
  callback();
  assert.equal(calls, 1, 'hydrated account resumes gameplay timer');
  runtime.setReady(false);
  fakeWindow.NETSHIFT_USER = null;
  callback();
  assert.equal(calls, 2, 'unauthenticated default UI timers keep their previous behaviour');

  for (const marker of [
    'setInterval(netshiftGuardGameplayTimer(tick),100)',
    'setInterval(netshiftGuardGameplayTimer(processNetworkDownloadsV11),100)',
    'setInterval(netshiftGuardGameplayTimer(runNpcAttackV11),1000)',
    'setInterval(netshiftGuardGameplayTimer(processSecurityTickV16),100)',
    'setInterval(netshiftGuardGameplayTimer(processLocalMalwareJobsV16),100)'
  ]) assert.ok(html.includes(marker), `gameplay interval is hydration-gated: ${marker}`);
  assert.ok(html.includes('if (netshiftGameplayIsBlocked() && !event.target?.closest?.("#authOverlay"))'), 'keyboard controls are blocked outside the loading overlay');
}

testProfileResponseValidation();
testInventoryResponseValidation();
testRequiredHydrationGateAndRetry();
testGameplayTimersPauseDuringHydration();
console.log('Stage 1 hydration gate checks OK (required profile/files, malformed-response rejection, retry, timeout and gameplay-timer pause).');
