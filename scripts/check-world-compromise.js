'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const { worldBreachChance } = require(path.join(root, 'lib', 'world-rules.js'));

assert.equal(worldBreachChance(0, false), 90, 'L0 uncontested host should be easiest.');
assert.equal(worldBreachChance(5, false), 25, 'L5 uncontested host should be harder than L0.');
assert.equal(worldBreachChance(0, true), 75, 'Contested host should be harder than an uncontested host.');
assert.equal(worldBreachChance(5, true), 10, 'Chance must remain bounded at minimum 10%.');
assert.equal(worldBreachChance(-100, false), 90, 'Negative levels are clamped to zero.');
assert.equal(worldBreachChance(100, true), 10, 'Out-of-range levels are clamped and odds bounded.');

const serverMarkers = [
  "app.post('/api/world/targets/:slug/breach'",
  'netshift_world_player_target_progress',
  "'PROBE_REQUIRED'",
  "'BREACH_COOLDOWN'",
  "crypto.randomInt(0, 100)",
  "'target.breached'",
  "'target.reclaimed'",
  "'target.breach-failed'",
  'worldBreachChance(securityLevel, contested)'
];
const clientMarkers = [
  'id="worldBreachButton"',
  'netshiftWorldBreach()',
  'myProbeCount',
  'compromisedByUsername'
];
const missing = [
  ...serverMarkers.filter(marker => !server.includes(marker)).map(marker => `server.js missing: ${marker}`),
  ...clientMarkers.filter(marker => !html.includes(marker)).map(marker => `public/index.html missing: ${marker}`)
];
if (missing.length) throw new Error(missing.join('\n'));
console.log('Shared host compromise rule and integration checks OK');
