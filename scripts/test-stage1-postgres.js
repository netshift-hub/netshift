'use strict';

// Opt-in PostgreSQL integration tests for the Stage 1 save cutover and host-download
// transaction behaviour. This script creates one random, isolated schema and drops only that
// schema on exit. It never reads DATABASE_URL or modifies application tables.
// Use a newly-created disposable database, not Render production or a live game DB.

const assert = require('node:assert/strict');
let Pool; // loaded only after an explicitly acknowledged test database is configured
const { claimHostDownload, HostDownloadClaimError } = require('../lib/host-download-claim');
const { applyLegacySaveCutover } = require('../lib/legacy-save-cutover');

const URL_ENV = 'NETSHIFT_STAGE1_TEST_DATABASE_URL';
const ACK_ENV = 'NETSHIFT_STAGE1_TEST_DB_ACK';
const REMOTE_ACK_ENV = 'NETSHIFT_STAGE1_ALLOW_REMOTE_TEST_DB';
const ACK_VALUE = 'I_CREATED_A_DISPOSABLE_DATABASE';
const REMOTE_ACK_VALUE = 'YES_I_CREATED_A_DISPOSABLE_POSTGRES_DATABASE';

function validateTestDatabaseUrl(value) {
  if (!value) return { skipped: true, reason: `${URL_ENV} is not set` };
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(`${URL_ENV} must be a valid PostgreSQL URL.`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${URL_ENV} must use postgres:// or postgresql://.`);
  }
  if (process.env[ACK_ENV] !== ACK_VALUE) {
    throw new Error(`Refusing to run PostgreSQL integration tests without ${ACK_ENV}=${ACK_VALUE}.`);
  }
  const host = parsed.hostname.toLowerCase();
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (/\.onrender\.com$|(^|\.)render\.com$/.test(host)) {
    throw new Error('Refusing to run destructive-schema integration tests against a Render host. Use a disposable local PostgreSQL database.');
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  const connectionIdentity = `${host}/${dbName}`;
  if (/(^|[.-])(main|prod|production|live)([.-]|$)/i.test(connectionIdentity) ||
      /(^|[-_])(prod|production|live)([-_]|$)/.test(dbName)) {
    throw new Error('Refusing a connection identity that appears to identify a main/live/production database.');
  }
  if (!localHost && !/(test|testing|disposable|stage|staging|scratch|ci)/i.test(dbName)) {
    throw new Error('Remote database name must visibly include test, disposable, stage/staging, scratch, or ci; create a clearly named disposable database.');
  }
  if (!localHost && process.env[REMOTE_ACK_ENV] !== REMOTE_ACK_VALUE) {
    throw new Error(`Remote PostgreSQL is blocked by default. For a newly-created disposable remote database only, set ${REMOTE_ACK_ENV}=${REMOTE_ACK_VALUE} as well as the disposable-database acknowledgement.`);
  }
  return { skipped: false, parsed, localHost };
}

function validPlayerFileName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 180 &&
    !/[\\/\0]/.test(name.trim()) && !['.', '..'].includes(name.trim());
}

function stockFixture() {
  return [
    { id: 'finance-readme', name: 'README.txt', type: 'file', content: 'Staging integration fixture.' },
    { id: 'finance-crc1', name: 'CRC L1.exe', type: 'software', family: 'crc', level: 1 }
  ];
}

async function resetFixture(pool, stock = stockFixture()) {
  await pool.query('DELETE FROM netshift_player_files');
  await pool.query('DELETE FROM netshift_world_loot_claims');
  await pool.query('DELETE FROM netshift_world_host_inventory');
  await pool.query('DELETE FROM netshift_world_targets');
  await pool.query('DELETE FROM netshift_account_ownership');
  await pool.query(`INSERT INTO netshift_account_ownership(user_id, session_id) VALUES (101, 'session-a'), (202, 'session-b')`);
  await pool.query(`INSERT INTO netshift_world_targets(slug, name, compromised_by_user_id) VALUES ('finance', 'Disposable Finance Host', 101)`);
  await pool.query(`INSERT INTO netshift_world_host_inventory(target_slug, stock, inventory_version) VALUES ('finance', $1::jsonb, 1)`, [JSON.stringify(stock)]);
}

async function readSnapshot(pool) {
  const [host, claims, files] = await Promise.all([
    pool.query(`SELECT stock, inventory_version, credential_lock_until FROM netshift_world_host_inventory WHERE target_slug='finance'`),
    pool.query(`SELECT id, item_key, claimed_by_user_id FROM netshift_world_loot_claims WHERE target_slug='finance' ORDER BY id`),
    pool.query(`SELECT id, user_id, parent_path, name, item_type, software_family, software_level FROM netshift_player_files ORDER BY name`)
  ]);
  return { host: host.rows[0], claims: claims.rows, files: files.rows };
}

async function expectClaimError(promise, status, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof HostDownloadClaimError, `expected HostDownloadClaimError, got ${error?.constructor?.name}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}


async function countCanonicalRows(pool) {
  const tables = [
    'netshift_users', 'netshift_player_world', 'netshift_bank_accounts',
    'netshift_player_files', 'netshift_world_targets', 'netshift_world_host_inventory',
    'netshift_world_loot_claims', 'netshift_admin_roles'
  ];
  const result = {};
  for (const table of tables) {
    const response = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${table}`);
    result[table] = response.rows[0].count;
  }
  return result;
}

async function runPostgresSaveCutoverTests(pool) {
  await pool.query('TRUNCATE netshift_migration_receipts, netshift_saves');
  await pool.query(`
    INSERT INTO netshift_users(id, username) VALUES (101, 'player-a');
    INSERT INTO netshift_player_world(user_id, workstation_ip, safety_shield) VALUES (101, '172.16.1.101', TRUE);
    INSERT INTO netshift_bank_accounts(id, owner_user_id, balance_cents) VALUES (501, 101, 50000);
    INSERT INTO netshift_player_files(id, user_id, parent_path, name, item_type, content)
      VALUES ('00000000-0000-4000-8000-000000000101', 101, '/', 'canonical.txt', 'file', 'keep me');
    INSERT INTO netshift_world_targets(slug, name, compromised_by_user_id) VALUES ('finance', 'Disposable Finance Host', 101);
    INSERT INTO netshift_world_host_inventory(target_slug, stock, inventory_version) VALUES ('finance', '[{"id":"static","name":"README.txt","type":"file"}]', 1);
    INSERT INTO netshift_world_loot_claims(target_slug, item_key, claimed_by_user_id) VALUES ('finance', 'already-claimed', 101);
    INSERT INTO netshift_admin_roles(user_id, mfa_required) VALUES (101, TRUE);
    INSERT INTO netshift_saves(user_id, save_data) VALUES
      (101, '{"schemaVersion":1,"state":{"accounts":{"player":{"balance":999999}}}}'),
      (202, '{"oldOrUnknown":true}'),
      (303, '{"schemaVersion":2,"preferences":{"lastAddress":"whois.com"}}');
  `);
  const canonicalBefore = await countCanonicalRows(pool);
  const first = await applyLegacySaveCutover(pool);
  assert.equal(first.applied, true);
  assert.equal(first.deletedSaveCount, 2);
  let saves = await pool.query('SELECT user_id, save_data FROM netshift_saves ORDER BY user_id');
  assert.equal(saves.rowCount, 1);
  assert.equal(Number(saves.rows[0].user_id), 303);
  assert.equal(saves.rows[0].save_data.schemaVersion, 2);
  assert.deepEqual(await countCanonicalRows(pool), canonicalBefore, 'legacy cutover must preserve dedicated canonical records');
  console.log('PG T1.1 PASS: one-time cutover removes only legacy/unknown save rows and preserves schema-v2 and canonical fixtures.');

  await pool.query(`INSERT INTO netshift_saves(user_id, save_data) VALUES (404, '{"schemaVersion":1,"state":{"owned":["forged"]}}')`);
  const retry = await applyLegacySaveCutover(pool);
  assert.equal(retry.applied, false);
  assert.equal(retry.deletedSaveCount, 0);
  saves = await pool.query('SELECT user_id FROM netshift_saves ORDER BY user_id');
  assert.deepEqual(saves.rows.map(row => Number(row.user_id)), [303, 404], 'an existing receipt makes the cutover idempotent');
  assert.deepEqual(await countCanonicalRows(pool), canonicalBefore);
  console.log('PG T1.2 PASS: migration receipt makes re-entry idempotent; canonical rows remain unchanged.');

  // A PostgreSQL trigger forces receipt insertion to fail after the scoped DELETE.
  // The test then proves that the deletion is rolled back by the same transaction.
  await pool.query('TRUNCATE netshift_migration_receipts, netshift_saves');
  await pool.query(`INSERT INTO netshift_saves(user_id, save_data) VALUES (101, '{"schemaVersion":1,"state":{"owned":["legacy"]}}')`);
  await pool.query(`
    CREATE FUNCTION stage1_fail_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic receipt insert failure'; END;
    $$;
    CREATE TRIGGER stage1_fail_receipt BEFORE INSERT ON netshift_migration_receipts
      FOR EACH ROW EXECUTE FUNCTION stage1_fail_receipt_insert();
  `);
  await assert.rejects(() => applyLegacySaveCutover(pool), /synthetic receipt insert failure/);
  const legacyAfterFailure = await pool.query('SELECT user_id FROM netshift_saves WHERE user_id=101');
  const receiptAfterFailure = await pool.query('SELECT migration_key FROM netshift_migration_receipts');
  assert.equal(legacyAfterFailure.rowCount, 1, 'save deletion must roll back when receipt creation fails');
  assert.equal(receiptAfterFailure.rowCount, 0, 'failed cutover must not leave a migration receipt');
  await pool.query('DROP TRIGGER stage1_fail_receipt ON netshift_migration_receipts');
  await pool.query('DROP FUNCTION stage1_fail_receipt_insert()');
  assert.deepEqual(await countCanonicalRows(pool), canonicalBefore);
  console.log('PG T1.3 PASS: real PostgreSQL trigger failure rolls back legacy-save deletion and receipt creation.');
  return 3;
}

async function runTests(pool) {
  let count = 0;
  // Real PostgreSQL transaction: canonical delivery, stock mutation and ledger.
  await resetFixture(pool);
  const delivered = await claimHostDownload(pool, {
    userId: '101', sessionId: 'session-a', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  });
  assert.equal(delivered.file.parent_path, '/downloads');
  assert.equal(delivered.file.item_type, 'software');
  assert.equal(delivered.file.software_family, 'crc');
  assert.equal(Number(delivered.file.software_level), 1);
  let snap = await readSnapshot(pool);
  assert.equal(snap.host.stock.some(item => item.id === 'finance-crc1'), false);
  assert.equal(Number(snap.host.inventory_version), 2);
  assert.equal(snap.claims.length, 1);
  assert.equal(snap.files.length, 1);
  count++;
  console.log('PG T4.1 PASS: claim, host stock update, claim ledger and canonical file commit atomically.');

  // PostgreSQL partial unique-index violation should roll back both earlier writes.
  await resetFixture(pool);
  await pool.query(`INSERT INTO netshift_player_files(id,user_id,parent_path,name,item_type,content) VALUES ('00000000-0000-4000-8000-000000000001',101,'/downloads','README.txt','file','existing')`);
  const beforeConflict = await readSnapshot(pool);
  await expectClaimError(claimHostDownload(pool, {
    userId: '101', sessionId: 'session-a', slug: 'finance', itemId: 'finance-readme', validPlayerFileName
  }), 409, 'DOWNLOAD_NAME_CONFLICT');
  snap = await readSnapshot(pool);
  assert.deepEqual(snap.host.stock, beforeConflict.host.stock);
  assert.equal(snap.host.inventory_version, beforeConflict.host.inventory_version);
  assert.equal(snap.claims.length, 0);
  assert.equal(snap.files.length, 1);
  count++;
  console.log('PG T4.2 PASS: filename conflict rolls back stock/version and ledger writes.');

  // Competing requests against the same item: host/ownership row locks allow one winner.
  await resetFixture(pool);
  const race = await Promise.allSettled([1, 2].map(() => claimHostDownload(pool, {
    userId: '101', sessionId: 'session-a', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  })));
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter(item => item.status === 'rejected').length, 1);
  const loser = race.find(item => item.status === 'rejected').reason;
  assert.ok(loser instanceof HostDownloadClaimError);
  assert.equal(loser.status, 409);
  snap = await readSnapshot(pool);
  assert.equal(snap.claims.length, 1);
  assert.equal(snap.files.length, 1);
  assert.equal(snap.host.stock.some(item => item.id === 'finance-crc1'), false);
  count++;
  console.log('PG T4.3 PASS: concurrent duplicate claim has exactly one winner and one canonical file.');

  // Identity and current-host control checks must reject before mutation.
  await resetFixture(pool);
  const beforeAccess = await readSnapshot(pool);
  await expectClaimError(claimHostDownload(pool, {
    userId: '101', sessionId: 'stale-session', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  }), 401, 'SESSION_REVOKED');
  await expectClaimError(claimHostDownload(pool, {
    userId: '202', sessionId: 'session-b', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  }), 403, 'HOST_ACCESS_REQUIRED');
  snap = await readSnapshot(pool);
  assert.deepEqual(snap.host.stock, beforeAccess.host.stock);
  assert.equal(snap.claims.length, 0);
  assert.equal(snap.files.length, 0);
  count++;
  console.log('PG T5.1 PASS: revoked session and non-controller account cannot mutate shared-host stock.');

  // A previously claimed ID remains spent even if a buggy caller reintroduces it.
  await resetFixture(pool);
  await claimHostDownload(pool, {
    userId: '101', sessionId: 'session-a', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  });
  await pool.query(`UPDATE netshift_world_host_inventory SET stock = stock || $1::jsonb WHERE target_slug='finance'`, [JSON.stringify([{ id: 'finance-crc1', name: 'CRC L1.exe', type: 'software', family: 'crc', level: 1 }])]);
  await expectClaimError(claimHostDownload(pool, {
    userId: '101', sessionId: 'session-a', slug: 'finance', itemId: 'finance-crc1', validPlayerFileName
  }), 409, 'ITEM_ALREADY_CLAIMED');
  snap = await readSnapshot(pool);
  assert.equal(snap.claims.length, 1);
  assert.equal(snap.files.length, 1);
  count++;
  console.log('PG T5.2 PASS: claimed item IDs cannot be awarded twice, even if reintroduced in stock.');
  return count;
}

async function main() {
  const validation = validateTestDatabaseUrl(process.env[URL_ENV]);
  if (validation.skipped) {
    console.log(`SKIP Stage 1 PostgreSQL integration tests: ${validation.reason}. No database connection was attempted.`);
    return;
  }

  Pool = require('pg').Pool;
  const schema = `ns_stage1_test_${process.pid}_${Date.now().toString(36)}`;
  const adminPool = new Pool({ connectionString: process.env[URL_ENV], max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  let appPool;
  let schemaCreated = false;
  try {
    // Ping before creating anything; CREATE/DROP is confined to this generated schema.
    await adminPool.query('SELECT 1');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    appPool = await setupSchemaUsingExistingSchema(schema);
    const cutoverTests = await runPostgresSaveCutoverTests(appPool);
    const claimTests = await runTests(appPool);
    const tests = cutoverTests + claimTests;
    console.log(`Stage 1 PostgreSQL integration tests PASS: ${tests} checks executed in isolated schema ${schema}.`);
  } finally {
    if (appPool) await appPool.end();
    if (schemaCreated) {
      try { await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      catch (error) { console.error(`WARNING: unable to drop isolated test schema ${schema}: ${error.message}`); }
    }
    await adminPool.end();
  }
}

// The main routine creates the schema once, then this helper adds the test tables.
async function setupSchemaUsingExistingSchema(schema) {
  // Using one dedicated connection makes search_path explicit for every query in
  // this test pool. The schema identifier is generated locally, never user input.
  const appPool = new Pool({
    connectionString: process.env[URL_ENV], max: 6, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`, statement_timeout: 15000
  });
  try {
  await appPool.query(`
    CREATE TABLE netshift_users (id BIGINT PRIMARY KEY, username VARCHAR(40) NOT NULL);
    CREATE TABLE netshift_player_world (user_id BIGINT PRIMARY KEY, workstation_ip INET NOT NULL, safety_shield BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE netshift_bank_accounts (id BIGINT PRIMARY KEY, owner_user_id BIGINT, balance_cents BIGINT NOT NULL DEFAULT 50000);
    CREATE TABLE netshift_admin_roles (user_id BIGINT PRIMARY KEY, mfa_required BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE netshift_saves (user_id BIGINT PRIMARY KEY, save_data JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE netshift_migration_receipts (
      migration_key VARCHAR(100) PRIMARY KEY, description VARCHAR(300) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE netshift_account_ownership (
      user_id BIGINT PRIMARY KEY, session_id VARCHAR NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE netshift_world_targets (
      slug VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, compromised_by_user_id BIGINT
    );
    CREATE TABLE netshift_world_host_inventory (
      target_slug VARCHAR(40) PRIMARY KEY, stock JSONB NOT NULL DEFAULT '[]'::jsonb,
      inventory_version BIGINT NOT NULL DEFAULT 1, last_intrusion_at TIMESTAMPTZ,
      next_regen_at TIMESTAMPTZ, credential_lock_until TIMESTAMPTZ
    );
    CREATE TABLE netshift_world_loot_claims (
      id BIGSERIAL PRIMARY KEY, target_slug VARCHAR(40) NOT NULL, item_key VARCHAR(120) NOT NULL,
      claimed_by_user_id BIGINT, regen_after TIMESTAMPTZ
    );
    CREATE TABLE netshift_player_files (
      id UUID PRIMARY KEY, user_id BIGINT NOT NULL, parent_path VARCHAR(500) NOT NULL DEFAULT '/',
      name VARCHAR(180) NOT NULL, item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('file','folder','software')),
      mime_type VARCHAR(100) NOT NULL DEFAULT 'text/plain', content TEXT NOT NULL DEFAULT '',
      software_family VARCHAR(40), software_level SMALLINT CHECK (software_level BETWEEN 1 AND 6),
      deleted_at TIMESTAMPTZ, recycle_bin_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX netshift_player_files_active_name_idx
      ON netshift_player_files(user_id, parent_path, name)
      WHERE deleted_at IS NULL AND recycle_bin_at IS NULL;
  `);
  return appPool;
  } catch (error) {
    await appPool.end();
    throw error;
  }
}

main().catch(error => {
  console.error(`Stage 1 PostgreSQL integration tests FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
