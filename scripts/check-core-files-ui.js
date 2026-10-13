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
assert.ok(saveBody.includes('!file?._coreFileId'), 'canonical Core files are excluded from client save payload');
console.log('Core file UI checks OK (server-backed Notepad, recycle bin, save ownership and Force Connect markers).');
