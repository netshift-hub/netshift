'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CURRENT_SAVE_SCHEMA_VERSION,
  LEGACY_SAVE_CUTOVER_KEY,
  applyLegacySaveCutover,
  isRetiredLegacySave
} = require('../lib/legacy-save-cutover');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// Small in-memory SQL adapter for the cutover helper. It exercises the helper's
// transaction boundaries, retry behaviour and lock protocol without connecting to a DB.
// This is not a substitute for PostgreSQL integration/staging validation.
class AsyncMutex {
  constructor() { this.tail = Promise.resolve(); }
  async acquire() {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

function cloneState(state) {
  return {
    saves: new Map(state.saves),
    receipts: new Map(state.receipts),
    canonical: structuredClone(state.canonical)
  };
}

class FakeDatabase {
  constructor(state) {
    this.state = cloneState(state);
    this.mutex = new AsyncMutex();
    this.failNextReceiptInsert = false;
  }
  async connect() { return new FakeClient(this); }
}

class FakeClient {
  constructor(database) {
    this.database = database;
    this.tx = null;
    this.releaseLock = null;
  }
  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin') { assert.equal(this.tx, null); return { rows: [], rowCount: null }; }
    if (normalized.startsWith('select pg_advisory_xact_lock(')) {
      this.releaseLock = await this.database.mutex.acquire();
      this.tx = cloneState(this.database.state); // Snapshot after lock: mirrors READ COMMITTED statement visibility.
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    assert.ok(this.tx, `query must run inside the migration transaction: ${normalized}`);
    if (normalized.startsWith('select migration_key from netshift_migration_receipts')) {
      const key = params[0];
      return this.tx.receipts.has(key)
        ? { rows: [{ migration_key: key }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("delete from netshift_saves where save_data->>'schemaversion' is distinct from $1")) {
      const currentVersion = String(params[0]);
      let rowCount = 0;
      for (const [userId, save] of this.tx.saves.entries()) {
        if (String(save?.schemaVersion ?? '') !== currentVersion) {
          this.tx.saves.delete(userId);
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (normalized.startsWith('insert into netshift_migration_receipts')) {
      if (this.database.failNextReceiptInsert) {
        this.database.failNextReceiptInsert = false;
        throw new Error('synthetic receipt insert failure');
      }
      const [key, description, detailText] = params;
      assert.ok(!this.tx.receipts.has(key), 'migration receipt key must be unique');
      this.tx.receipts.set(key, { description, details: JSON.parse(detailText) });
      return { rows: [], rowCount: 1 };
    }
    if (normalized === 'commit') {
      this.database.state = this.tx;
      this.tx = null;
      this.unlock();
      return { rows: [], rowCount: null };
    }
    if (normalized === 'rollback') {
      this.tx = null;
      this.unlock();
      return { rows: [], rowCount: null };
    }
    throw new Error(`Unexpected SQL in cutover test adapter: ${normalized}`);
  }
  unlock() {
    if (this.releaseLock) { this.releaseLock(); this.releaseLock = null; }
  }
  release() { this.unlock(); }
}

function fixtureDatabase() {
  return new FakeDatabase({
    saves: new Map([
      ['101', { schemaVersion: 1, state: { owned: ['legacy-client-item'], accounts: { player: { balance: 999999 } } } }],
      ['202', { schemaVersion: 1, state: { localFiles: [{ name: 'legacy.txt' }] } }],
      ['909', { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } }]
    ]),
    receipts: new Map(),
    canonical: {
      users: [{ id: '101', username: 'player-a' }, { id: '202', username: 'player-b' }],
      bankAccounts: [{ ownerUserId: '101', balanceCents: 50000 }],
      playerFiles: [{ id: 'canonical-file-1', userId: '101', name: 'server-notes.txt' }],
      worldClaims: [{ id: 7, target: 'finance', itemKey: 'claimed-item' }],
      adminRoles: [{ userId: '202', mfaRequired: true }]
    }
  });
}

async function testFirstRunAndPreservation() {
  const db = fixtureDatabase();
  const canonicalBefore = structuredClone(db.state.canonical);
  const result = await applyLegacySaveCutover(db);
  assert.equal(result.applied, true);
  assert.equal(result.deletedSaveCount, 2, 'only schema-v1 legacy rows should be retired');
  assert.equal(result.migrationKey, LEGACY_SAVE_CUTOVER_KEY);
  assert.equal(db.state.saves.size, 1, 'schema-v2 save documents must survive a legacy-only reset');
  assert.equal(db.state.saves.has('909'), true);
  assert.equal(db.state.receipts.size, 1);
  assert.deepEqual(db.state.canonical, canonicalBefore, 'canonical server records must remain unchanged');
  assert.deepEqual(db.state.receipts.get(LEGACY_SAVE_CUTOVER_KEY).details.canonicalTablesTouched, []);
}

async function testRetryDoesNotEraseNewRows() {
  const db = fixtureDatabase();
  const first = await applyLegacySaveCutover(db);
  assert.equal(first.applied, true);
  db.state.saves.set('303', { schemaVersion: 2, preferences: { lastAddress: 'whois.com' } });
  const second = await applyLegacySaveCutover(db);
  assert.equal(second.applied, false);
  assert.equal(second.deletedSaveCount, 0);
  assert.equal(db.state.receipts.size, 1);
  assert.equal(db.state.saves.size, 2, 'a retry must not clear schema-v2 data created before or after the receipt');
  assert.equal(db.state.saves.has('909'), true);
  assert.equal(db.state.saves.has('303'), true);
}

async function testReceiptFailureRollsBackDeletion() {
  const db = fixtureDatabase();
  const savesBefore = new Map(db.state.saves);
  const canonicalBefore = structuredClone(db.state.canonical);
  db.failNextReceiptInsert = true;
  await assert.rejects(() => applyLegacySaveCutover(db), /synthetic receipt insert failure/);
  assert.deepEqual(db.state.saves, savesBefore, 'failed receipt insertion must roll back save deletion');
  assert.equal(db.state.receipts.size, 0, 'failed migration must not leave a receipt');
  assert.deepEqual(db.state.canonical, canonicalBefore, 'failure must not change canonical records');
}

async function testConcurrentStartsApplyOnce() {
  const db = fixtureDatabase();
  const results = await Promise.all(Array.from({ length: 8 }, () => applyLegacySaveCutover(db)));
  assert.equal(results.filter(result => result.applied).length, 1, 'only one concurrent runner applies the reset');
  assert.equal(db.state.receipts.size, 1, 'one receipt must remain');
  assert.equal(db.state.saves.size, 1, 'legacy rows must be removed while schema-v2 rows are preserved');
  assert.equal(db.state.saves.has('909'), true);
}

function testRetiredSchemaAndServerWiring() {
  assert.equal(CURRENT_SAVE_SCHEMA_VERSION, 2);
  assert.equal(isRetiredLegacySave({ schemaVersion: 1, baseRevision: 0, state: { owned: ['forged'] } }), true);
  assert.equal(isRetiredLegacySave({ schemaVersion: 2, preferences: { lastAddress: 'whois.com' } }), false);
  assert.equal(isRetiredLegacySave(null), false);
  assert.equal(isRetiredLegacySave([]), false);

  assert.ok(server.includes("require('./lib/legacy-save-cutover')"), 'server must load cutover helper');
  assert.ok(server.includes('CREATE TABLE IF NOT EXISTS netshift_migration_receipts'), 'receipt table must be created before cutover');
  assert.ok(server.includes('await applyLegacySaveCutover(pool)'), 'startup must await cutover before listening');
  assert.ok(server.includes("if (isRetiredLegacySave(payload))"), 'save API must reject retired schema v1');
  assert.ok(server.includes('code: \'LEGACY_SAVE_RETIRED\''), 'retired save rejection must be distinguishable');
  assert.ok(!server.includes("code: 'SAVE_PROTOCOL_NOT_READY'"), 'the schema-v2 preferences writer should now be enabled');
  assert.ok(server.includes('normaliseStoredSave(row.save_data)'), 'save reads must validate and sanitise stored documents');
  assert.ok(server.includes('const validation = validateSaveRequest(payload)'), 'save writes must use the schema-v2 allowlist validator');
  const savePostStart = server.indexOf("app.post('/api/save', requireAuth, saveLimiter");
  const coreApiStart = server.indexOf('// NETSHIFT Core v2 APIs.', savePostStart);
  const savePostRoute = server.slice(savePostStart, coreApiStart);
  assert.ok(/INSERT INTO netshift_saves/i.test(savePostRoute) && /UPDATE netshift_saves/i.test(savePostRoute), 'the schema-v2 allowlisted writer should support safe create/update operations');
  assert.ok(savePostRoute.includes('currentRevision'), 'save responses must expose the current revision for stale-client recovery');
  const initCall = server.indexOf('await applyLegacySaveCutover(pool)');
  const listenCall = server.lastIndexOf('httpServer.listen(');
  assert.ok(initCall >= 0 && listenCall > initCall, 'database cutover must complete before HTTP listen');
  const helper = fs.readFileSync(path.join(root, 'lib', 'legacy-save-cutover.js'), 'utf8');
  assert.ok(helper.includes("DELETE FROM netshift_saves WHERE save_data->>'schemaVersion' IS DISTINCT FROM $1"), 'reset must scope deletion to legacy/unknown save versions');
  assert.ok(!/DELETE\s+FROM\s+netshift_(users|player_world|bank_accounts|player_files|world_targets|world_host_inventory|world_loot_claims|admin_roles)/i.test(helper), 'reset helper must not delete canonical records');
}

(async () => {
  await testFirstRunAndPreservation();
  await testRetryDoesNotEraseNewRows();
  await testReceiptFailureRollsBackDeletion();
  await testConcurrentStartsApplyOnce();
  testRetiredSchemaAndServerWiring();
  console.log('Stage 1 save cutover tests OK (first run, canonical preservation, retry, rollback, concurrency, stale-save rejection).');
  console.log('Note: tests use an isolated in-memory SQL adapter; PostgreSQL/staging integration remains unverified.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
