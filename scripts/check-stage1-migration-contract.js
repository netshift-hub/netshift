'use strict';

// Contract/fixture consistency check only. This script does not connect to a DB,
// execute the reset, or claim that migration/runtime behaviour has been tested.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const contractPath = path.join(root, 'NETSHIFT_STAGE1_MIGRATION_CONTRACT.md');
const fixturePath = path.join(__dirname, 'fixtures', 'stage1-save-reset-cases.json');
const contract = fs.readFileSync(contractPath, 'utf8');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

assert.ok(contract.includes('Approved product decision: legacy saves are disposable'), 'contract must document the approved save-discard decision');
assert.ok(contract.includes('Data that must remain intact'), 'contract must distinguish disposable saves from canonical server records');
assert.ok(contract.includes('One-time and atomic'), 'contract must require atomic idempotent reset semantics');
assert.ok(contract.includes('Version-gated'), 'contract must require stale schema-v1 write rejection');
assert.equal(fixtures.contractVersion, 1, 'fixture contract version must be supported');
assert.equal(fixtures.policy.legacySaveAction, 'discard');
assert.equal(fixtures.policy.canonicalServerRecordsAction, 'preserve');
assert.equal(fixtures.policy.migrateLegacyPurchases, false);
assert.equal(fixtures.policy.createPurchaseLedgerRows, false);
assert.equal(fixtures.policy.deletePlayerAccounts, false);
assert.equal(fixtures.policy.deleteCanonicalPlayerFiles, false);

const cases = fixtures.cases;
assert.ok(Array.isArray(cases) && cases.length >= 10, 'expected a useful set of migration boundary fixtures');
const ids = cases.map(testCase => testCase.id);
assert.equal(new Set(ids).size, ids.length, 'fixture IDs must be unique');
for (const testCase of cases) {
  assert.ok(testCase.description && typeof testCase.description === 'string', `${testCase.id}: missing description`);
  assert.ok(testCase.expected && typeof testCase.expected === 'object', `${testCase.id}: missing expected outcomes`);
}
for (const id of [
  'empty-legacy-v1-save',
  'legacy-owned-software-does-not-create-ownership',
  'legacy-balance-and-purchase-claims-ignored',
  'legacy-demo-bank-info-credentials',
  'malformed-or-unknown-version-save',
  'preserve-existing-canonical-text-file',
  'preserve-existing-canonical-software',
  'stale-client-v1-save-after-cutover',
  'v2-save-protected-state-injection',
  'reset-marker-retry-and-concurrency',
  'download-filename-conflict-rolls-back-claim',
  'concurrent-same-host-item-claim'
]) assert.ok(ids.includes(id), `required fixture is missing: ${id}`);

const canonicalPreservation = cases.filter(c => c.canonicalRowsBefore);
assert.ok(canonicalPreservation.length >= 2, 'fixtures must cover preservation of canonical files and software');
assert.ok(cases.some(c => c.expected?.purchaseRowsCreated === 0) && cases.some(c => c.expected?.ledgerRowsCreated === 0), 'legacy inventory must not create purchase or ledger records');
assert.ok(cases.some(c => c.expected?.httpStatus === 400), 'fixtures must cover rejection of stale save writes');
assert.ok(cases.some(c => c.expected?.resetAppliedCount === 1), 'fixtures must cover retry/concurrency idempotency');

console.log(`Stage 1 migration contract fixtures OK (${cases.length} scenarios). PostgreSQL integration is separate from this fixture check.`);
