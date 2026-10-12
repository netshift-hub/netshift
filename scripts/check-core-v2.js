'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const requiredServer = [
  'CREATE TABLE IF NOT EXISTS netshift_player_world',
  'CREATE TABLE IF NOT EXISTS netshift_bank_accounts',
  'CREATE TABLE IF NOT EXISTS netshift_player_files',
  'CREATE TABLE IF NOT EXISTS netshift_world_host_inventory',
  "app.post('/api/core/safetyshield'",
  "app.post('/api/core/bank/first-login'",
  "app.post('/api/core/hosts/:slug/download'",
  "app.get('/api/admin/viewusers'",
  "app.post('/api/admin/:action/:username'",
  "app.get('/api/admin/logs'",
  'credential_lock_until',
  'shield_has_been_changed',
  'if (current.shield_has_been_changed)',
  'netshift_admin_roles'
];
const requiredClient = [
  'netshiftCoreShieldDialog',
  'one hour before you can enable SafetyShield again',
  'netshiftDesktopCreate',
  'New Text Document',
  'New Folder'
];
for (const marker of requiredServer) assert.ok(server.includes(marker), `server missing ${marker}`);
for (const marker of requiredClient) assert.ok(html.includes(marker), `client missing ${marker}`);
console.log('Core v2 schema, SafetyShield, files, shared downloads and admin API markers OK');
