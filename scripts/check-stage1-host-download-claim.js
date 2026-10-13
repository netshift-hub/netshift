'use strict';

// Focused transactional contract test using a deterministic in-memory PostgreSQL
// adapter. This exercises the real claim service's control flow; it is not a
// substitute for PostgreSQL integration testing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HostDownloadClaimError,
  assertHostSlug,
  assertHostItemId,
  normaliseHostStock,
  publicHostStockItem,
  claimHostDownload
} = require('../lib/host-download-claim');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function validPlayerFileName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 180 &&
    !/[\\/\0]/.test(name.trim()) && !['.', '..'].includes(name.trim());
}

function mutex() {
  let tail = Promise.resolve();
  return async function acquire() {
    let unlock;
    const hold = new Promise(resolve => { unlock = resolve; });
    const previous = tail;
    tail = previous.then(() => hold);
    await previous;
    let released = false;
    return () => { if (!released) { released = true; unlock(); } };
  };
}

function createFakePool({
  stock = [
    { id: 'finance-readme', name: 'README.txt', type: 'file', content: 'Public readme.' },
    { id: 'finance-warez1', name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1 }
  ],
  targetOwnerId = '7',
  sessionId = 'session-a',
  userId = '7',
  files = [],
  failPlayerFileInsert = false
} = {}) {
  const db = {
    ownership: { user_id: userId, session_id: sessionId },
    target: { slug: 'finance', name: 'Small Finance Co.', compromised_by_user_id: targetOwnerId },
    host: { target_slug: 'finance', stock: structuredClone(stock), inventory_version: '1', credential_lock_until: null, last_intrusion_at: null, next_regen_at: null },
    claims: [],
    files: structuredClone(files),
    sequence: 1,
    statements: []
  };
  const acquireHost = mutex();

  const pool = {
    async connect() {
      const tx = { stock: null, version: null, credential: false, claim: null, file: null, lockRelease: null, open: false };
      return {
        async query(sql, params = []) {
          const q = sql.replace(/\s+/g, ' ').trim();
          db.statements.push(q);
          if (q === 'BEGIN') { tx.open = true; return { rows: [], rowCount: null }; }
          if (q === 'COMMIT') {
            if (tx.stock !== null) {
              db.host.stock = tx.stock;
              db.host.inventory_version = String(Number(db.host.inventory_version) + 1);
              db.host.last_intrusion_at = db.host.last_intrusion_at || 'now';
              db.host.next_regen_at = db.host.next_regen_at || 'now+5m';
              if (tx.credential) db.host.credential_lock_until = 'now+3d';
            }
            if (tx.claim) db.claims.push(tx.claim);
            if (tx.file) db.files.push(tx.file);
            tx.open = false;
            tx.lockRelease?.(); tx.lockRelease = null;
            return { rows: [], rowCount: null };
          }
          if (q === 'ROLLBACK') {
            tx.stock = null; tx.claim = null; tx.file = null; tx.open = false;
            tx.lockRelease?.(); tx.lockRelease = null;
            return { rows: [], rowCount: null };
          }
          if (q.startsWith('SELECT session_id FROM netshift_account_ownership')) {
            return db.ownership && String(db.ownership.user_id) === String(params[0])
              ? { rows: [{ session_id: db.ownership.session_id }], rowCount: 1 }
              : { rows: [], rowCount: 0 };
          }
          if (q.startsWith('UPDATE netshift_account_ownership SET last_seen_at')) return { rows: [], rowCount: 1 };
          if (q.startsWith('SELECT slug, name, compromised_by_user_id FROM netshift_world_targets')) {
            if (!tx.lockRelease) tx.lockRelease = await acquireHost();
            return db.target && db.target.slug === params[0]
              ? { rows: [structuredClone(db.target)], rowCount: 1 }
              : { rows: [], rowCount: 0 };
          }
          if (q.startsWith('SELECT target_slug, stock, inventory_version, credential_lock_until FROM netshift_world_host_inventory')) {
            return db.host && db.host.target_slug === params[0]
              ? { rows: [{ ...structuredClone(db.host), stock: structuredClone(db.host.stock) }], rowCount: 1 }
              : { rows: [], rowCount: 0 };
          }
          if (q.startsWith('SELECT id FROM netshift_world_loot_claims')) {
            const prior = db.claims.find(row => row.target_slug === params[0] && row.item_key === params[1]);
            return prior ? { rows: [{ id: prior.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (q.startsWith('UPDATE netshift_world_host_inventory SET stock=')) {
            if (String(db.host.inventory_version) !== String(params[3])) return { rows: [], rowCount: 0 };
            tx.stock = JSON.parse(params[1]);
            tx.version = Number(db.host.inventory_version) + 1;
            tx.credential = params[2] === true;
            return { rows: [{ inventory_version: String(tx.version), next_regen_at: 'now+5m' }], rowCount: 1 };
          }
          if (q.startsWith('INSERT INTO netshift_world_loot_claims')) {
            tx.claim = { id: db.sequence++, target_slug: params[0], item_key: params[1], claimed_by_user_id: params[2] };
            return { rows: [{ id: tx.claim.id, item_key: tx.claim.item_key }], rowCount: 1 };
          }
          if (q.startsWith('INSERT INTO netshift_player_files')) {
            if (failPlayerFileInsert) { const error = new Error('simulated canonical inventory write failure'); error.code = 'XX000'; throw error; }
            const file = {
              id: params[0], user_id: params[1], parent_path: '/downloads',
              name: params[2], item_type: params[3], mime_type: params[4], content: params[5],
              software_family: params[6], software_level: params[7], created_at: 'now', updated_at: 'now'
            };
            const conflict = [...db.files, ...(tx.file ? [tx.file] : [])].some(existing =>
              String(existing.user_id) === String(file.user_id) && existing.parent_path === '/downloads' &&
              existing.name === file.name && existing.deleted_at == null && existing.recycle_bin_at == null);
            if (conflict) {
              const error = new Error('unique active filename conflict'); error.code = '23505'; error.constraint = 'netshift_player_files_active_name_idx'; throw error;
            }
            file.parent_path = '/downloads';
            tx.file = file;
            return { rows: [structuredClone(file)], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL in test adapter: ${q}`);
        },
        release() { tx.lockRelease?.(); tx.lockRelease = null; }
      };
    }
  };
  return { pool, db };
}

async function expectHostError(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof HostDownloadClaimError, `expected HostDownloadClaimError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

async function testCanonicalDeliveryAndSingleCommit() {
  const { pool, db } = createFakePool();
  const result = await claimHostDownload(pool, { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName });
  assert.equal(result.file.parent_path, '/downloads');
  assert.equal(result.file.item_type, 'software');
  assert.equal(result.file.software_family, 'warez');
  assert.equal(result.file.software_level, 1);
  assert.equal(result.file.name, 'Warez Virus L1.vshare');
  assert.equal(db.host.stock.some(item => item.id === 'finance-warez1'), false);
  assert.equal(db.claims.length, 1);
  assert.equal(db.claims[0].item_key, 'finance-warez1');
  assert.equal(db.files.length, 1);
  assert.equal(db.host.inventory_version, '2');
  assert.ok(db.statements.includes('COMMIT'));
  assert.ok(!db.statements.some(q => /ON CONFLICT DO NOTHING/i.test(q)), 'download delivery must not silently skip a conflicting player-file row');
}

async function testFilenameConflictRollsBackAllThreeWrites() {
  const existing = { id: 'existing-software', user_id: '7', parent_path: '/downloads', name: 'Warez Virus L1.vshare', item_type: 'software', deleted_at: null, recycle_bin_at: null };
  const { pool, db } = createFakePool({ files: [existing] });
  const stockBefore = structuredClone(db.host.stock);
  await expectHostError(claimHostDownload(pool, { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName }), 'DOWNLOAD_NAME_CONFLICT', 409);
  assert.deepEqual(db.host.stock, stockBefore, 'stock remains available after delivery conflict');
  assert.equal(db.claims.length, 0, 'claim ledger remains untouched after delivery conflict');
  assert.equal(db.files.length, 1, 'no duplicate file is created');
  assert.ok(db.statements.includes('ROLLBACK'));
  assert.ok(!db.statements.includes('COMMIT'));
}

async function testUnexpectedInventoryFailureRollsBackAllWrites() {
  const { pool, db } = createFakePool({ failPlayerFileInsert: true });
  const stockBefore = structuredClone(db.host.stock);
  await assert.rejects(claimHostDownload(pool, { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName }), /simulated canonical inventory write failure/);
  assert.deepEqual(db.host.stock, stockBefore, 'stock update rolls back on an unexpected file-write failure');
  assert.equal(db.claims.length, 0, 'claim ledger insert rolls back on an unexpected file-write failure');
  assert.equal(db.files.length, 0, 'failed file write leaves no player inventory record');
  assert.ok(db.statements.includes('ROLLBACK'));
  assert.ok(!db.statements.includes('COMMIT'));
}

async function testConcurrentClaimsHaveOneWinner() {
  const { pool, db } = createFakePool();
  const args = { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName };
  const results = await Promise.allSettled([claimHostDownload(pool, args), claimHostDownload(pool, args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const rejected = results.find(r => r.status === 'rejected').reason;
  assert.ok(rejected instanceof HostDownloadClaimError);
  assert.equal(rejected.status, 409);
  assert.equal(db.claims.length, 1);
  assert.equal(db.files.length, 1);
  assert.equal(db.host.stock.filter(item => item.id === 'finance-warez1').length, 0);
  assert.equal(db.host.inventory_version, '2');
}

async function testPreviouslyClaimedIdCannotBeReused() {
  const { pool, db } = createFakePool();
  const args = { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName };
  await claimHostDownload(pool, args);
  db.host.stock.push({ id: 'finance-warez1', name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1 });
  const beforeFiles = db.files.length, beforeClaims = db.claims.length, beforeVersion = db.host.inventory_version;
  await expectHostError(claimHostDownload(pool, args), 'ITEM_ALREADY_CLAIMED', 409);
  assert.equal(db.files.length, beforeFiles);
  assert.equal(db.claims.length, beforeClaims);
  assert.equal(db.host.inventory_version, beforeVersion);
}

async function testHostOwnershipAndMetadataValidation() {
  const unauthorised = createFakePool({ targetOwnerId: '8' });
  const stockBefore = structuredClone(unauthorised.db.host.stock);
  await expectHostError(claimHostDownload(unauthorised.pool, { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-warez1', validPlayerFileName }), 'HOST_ACCESS_REQUIRED', 403);
  assert.deepEqual(unauthorised.db.host.stock, stockBefore);
  assert.equal(unauthorised.db.claims.length, 0);

  const malformed = createFakePool({ stock: [{ id: 'finance-bad', name: 'tool.exe', type: 'software', level: 1 }] });
  await expectHostError(claimHostDownload(malformed.pool, { userId: '7', sessionId: 'session-a', slug: 'finance', itemId: 'finance-bad', validPlayerFileName }), 'HOST_STOCK_INVALID', 500);
  assert.equal(malformed.db.claims.length, 0);
  assert.equal(malformed.db.files.length, 0);

  assert.throws(() => assertHostSlug('../finance'), error => error.code === 'INVALID_HOST');
  assert.throws(() => assertHostItemId({ id: 'finance-warez1' }), error => error.code === 'INVALID_ITEM_ID');
  assert.throws(() => normaliseHostStock([{ id: 'x', name: 'same.txt', type: 'file' }, { id: 'x', name: 'second.txt', type: 'file' }], validPlayerFileName), error => error.code === 'HOST_STOCK_INVALID');
  const safe = normaliseHostStock([{ id: 'x', name: 'README.txt', type: 'file', content: 'secret', credential: true }], validPlayerFileName)[0];
  assert.deepEqual(publicHostStockItem(safe), { id: 'x', name: 'README.txt', type: 'file' }, 'inventory list omits content and internal credential metadata');
}

function testRoutesAndClientFlowAreConnected() {
  const inventoryRouteStart = serverSource.indexOf("app.get('/api/core/hosts/:slug/inventory'");
  const downloadRouteStart = serverSource.indexOf("app.post('/api/core/hosts/:slug/download'");
  const adminRouteStart = serverSource.indexOf("app.get('/api/admin/viewusers'", downloadRouteStart);
  assert.ok(inventoryRouteStart >= 0 && downloadRouteStart > inventoryRouteStart && adminRouteStart > downloadRouteStart, 'owner-protected stock-read and download routes exist in order');
  const inventoryRoute = serverSource.slice(inventoryRouteStart, downloadRouteStart);
  const downloadRoute = serverSource.slice(downloadRouteStart, adminRouteStart);
  assert.ok(inventoryRoute.includes('requireSessionOwnership(req, res)'));
  assert.ok(inventoryRoute.includes('compromised_by_user_id'));
  assert.ok(inventoryRoute.includes('normaliseHostStock'));
  assert.ok(downloadRoute.includes('hostDownloadLimiter'));
  assert.ok(downloadRoute.includes('claimHostDownload(pool'));
  assert.ok(!downloadRoute.includes('req.body?.name') && !downloadRoute.includes('req.body?.type') && !downloadRoute.includes('req.body?.family'), 'client cannot provide canonical item type/name/family');

  assert.ok(htmlSource.includes('id="worldHostInventory"'), 'shared host panel has a host inventory surface');
  assert.ok(htmlSource.includes('netshiftWorldLoadHostInventory'), 'client can request stock for a host it controls');
  assert.ok(htmlSource.includes("/api/core/hosts/${encodeURIComponent(slug)}/inventory"), 'client fetches canonical server host stock');
  assert.ok(htmlSource.includes("/api/core/hosts/${encodeURIComponent(slug)}/download"), 'client claims stock using canonical endpoint');
  assert.ok(htmlSource.includes('await netshiftCoreLoadFiles({ quiet: true })'), 'successful claim refreshes canonical player inventory');
  assert.ok(pkg.scripts.check.includes('node scripts/check-stage1-host-download-claim.js'), 'new host claim contract test is part of npm run check');
}

(async () => {
  await testCanonicalDeliveryAndSingleCommit();
  await testFilenameConflictRollsBackAllThreeWrites();
  await testUnexpectedInventoryFailureRollsBackAllWrites();
  await testConcurrentClaimsHaveOneWinner();
  await testPreviouslyClaimedIdCannotBeReused();
  await testHostOwnershipAndMetadataValidation();
  testRoutesAndClientFlowAreConnected();
  console.log('Stage 1 host-download claim checks OK (atomic delivery, conflict rollback, duplicate IDs, current host control, trusted metadata, and connected UI flow). PostgreSQL/browser integration remains separate.');
})().catch(error => { console.error(error); process.exitCode = 1; });
