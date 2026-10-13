'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

for (const marker of [
  "app.get('/api/core/files/recycle-bin'",
  "app.post('/api/core/files/:id/restore'",
  "app.delete('/api/core/files/:id/permanent'",
  "app.post('/api/auth/force-connect'",
  'pendingForceConnect',
  'ACTIVE_SESSION_REACHABLE',
  'recycle_bin_at',
  'netshift_password_reset_tokens',
  'email_verified_at'
]) assert.ok(server.includes(marker), `server missing ${marker}`);

for (const marker of [
  'netshiftCoreLoadFiles',
  'netshiftCoreCreateDesktopItem',
  'netshiftOpenCoreNotepad',
  'netshiftCoreSaveNotepad',
  'netshiftCoreReloadNotepad',
  'NETSHIFT_CORE_FILES',
  'Force Connect — take over unreachable session',
  'NETSHIFT disk',
  "'NONE'"
]) assert.ok(html.includes(marker), `client missing ${marker}`);

const createStart = html.lastIndexOf('function netshiftDesktopCreate(type) {');
const createEnd = html.indexOf('\n}', createStart);
assert.ok(createStart >= 0 && createEnd > createStart, 'active desktop create function found');
const activeCreate = html.slice(createStart, createEnd);
assert.ok(activeCreate.includes('netshiftCoreCreateDesktopItem'), 'desktop create uses Core API');
assert.ok(!activeCreate.includes('prompt('), 'desktop create must not invoke native prompt dialogs');

const saveStart = html.indexOf('function netshiftSnapshot() {');
const saveEnd = html.indexOf('\n}', saveStart);
const saveBody = html.slice(saveStart, saveEnd);
assert.ok(saveStart >= 0 && saveEnd > saveStart, 'client preference snapshot function found');
assert.ok(saveBody.includes('schemaVersion: 2'), 'client snapshot uses schema v2');
assert.ok(saveBody.includes('preferences: { lastAddress:'), 'client snapshot only serialises allowlisted address preference');
assert.ok(!saveBody.includes('state:'), 'client snapshot does not serialise game state');
assert.ok(!saveBody.includes('localFiles') && !saveBody.includes('state.owned'), 'client snapshot does not serialise canonical inventory or legacy ownership');

// Regression guard: the first desktop render calls the active Chunk 8 implementation
// of refreshDesktopIcons(), which reads these `let` bindings. They must be initialised
// before startup invokes any renderer, or authentication handlers below startup never attach.
const startupBlock = html.indexOf("if(!activeBrowserSurfaceV16) initBrowserTabsV16();");
assert.ok(startupBlock >= 0, 'initial desktop startup block found');
for (const variable of [
  'NETSHIFT_CORE_FILES',
  'NETSHIFT_CORE_SOFTWARE',
  'NETSHIFT_CORE_FOLDERS',
  'NETSHIFT_CORE_RECYCLE_FILES'
]) {
  const declaration = `let ${variable} = [];`;
  assert.equal(html.split(declaration).length - 1, 1, `${variable} is declared exactly once`);
  assert.ok(html.indexOf(declaration) < startupBlock, `${variable} is initialised before the first desktop render`);
}

// Authentication handlers must be attached and submit credentials via JSON POST,
// not native form navigation that can put credentials in the URL query string.
const authHandlerStart = html.indexOf('async function netshiftHandleAuthSubmit(event, mode) {');
const authHandlerEnd = html.indexOf('\n}', authHandlerStart);
assert.ok(authHandlerStart >= 0 && authHandlerEnd > authHandlerStart, 'active auth submit handler found');
const authHandler = html.slice(authHandlerStart, authHandlerEnd);
assert.ok(authHandler.includes('event.preventDefault();'), 'auth submit prevents native form navigation');
assert.ok(authHandler.includes('method:"POST"'), 'auth submit uses POST');
assert.ok(authHandler.includes('JSON.stringify({username,password})'), 'auth credentials are submitted as JSON body');
assert.ok(authHandler.includes('isRegister ? "/api/auth/register" : "/api/auth/login"'), 'auth submit calls the correct auth endpoint');
assert.ok(html.includes('$("loginForm").addEventListener("submit", event => netshiftHandleAuthSubmit(event, "login"));'), 'login submit handler is attached');
assert.ok(html.includes('$("registerForm").addEventListener("submit", event => netshiftHandleAuthSubmit(event, "register"));'), 'registration submit handler is attached');

console.log('Core file UI checks OK (server-backed Notepad, recycle bin, preferences-only save ownership and Force Connect markers).');
