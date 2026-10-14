'use strict';

// Fast deterministic E1 contract tests. These do not connect to PostgreSQL; the
// opt-in test:economy:postgres command verifies actual constraints and transactions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalisePostings, normaliseObject, hashMoneyRequest, validateMerchantPosting,
  ensureMoneyLedgerBaseline, createMoneyTransaction, recordAssetEvent, validateIdempotencyKey, EconomyLedgerError
} = require('../lib/economy-ledger');
const { WEBSITE_MERCHANT_SEEDS, ECONOMY_LEDGER_DDL } = require('../lib/economy-ledger-schema');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const guide = fs.readFileSync(path.join(root, 'NETSHIFT_ECONOMY_LEDGER_DESIGN.md'), 'utf8');

const hackwarePostings = [
  { bankAccountId: '501', accountOwnerUserId: '101', amountCents: -15000 },
  { bankAccountId: null, accountOwnerUserId: null, systemAccount: 'website_treasury:hackware', amountCents: 15000 }
];
assert.equal(normalisePostings(hackwarePostings).reduce((sum, row) => sum + row.amountCents, 0), 0);
assert.throws(() => normalisePostings([
  { bankAccountId: '501', accountOwnerUserId: '101', amountCents: -15000 },
  { bankAccountId: null, accountOwnerUserId: null, systemAccount: 'money_issuance', amountCents: 14999 }
]), error => error instanceof EconomyLedgerError && error.code === 'LEDGER_NOT_BALANCED');
assert.throws(() => normalisePostings([
  { bankAccountId: '501', accountOwnerUserId: '101', amountCents: 0 },
  { bankAccountId: null, accountOwnerUserId: null, systemAccount: 'money_issuance', amountCents: 0 }
]), error => error instanceof EconomyLedgerError && error.code === 'LEDGER_POSTINGS_INVALID');
assert.equal(validateIdempotencyKey('website-sale-hackware-01'), true);
assert.equal(validateIdempotencyKey('bad'), false);
assert.throws(() => normaliseObject(['not', 'an', 'object'], 'metadata'), error => error.code === 'LEDGER_METADATA_INVALID');
assert.throws(() => validateMerchantPosting('hackware', [
  { bankAccountId: '501', accountOwnerUserId: '101', amountCents: -15000 },
  { bankAccountId: null, accountOwnerUserId: null, systemAccount: 'website_treasury:computerstore', amountCents: 15000 }
]), error => error.code === 'MERCHANT_POSTING_INVALID');
assert.throws(() => validateMerchantPosting(null, hackwarePostings), error => error.code === 'MERCHANT_ATTRIBUTION_REQUIRED');

const request = {
  idempotencyKey: 'website-sale-hackware-01', transactionType: 'software_purchase', actorUserId: '101',
  merchantKey: 'hackware', metadata: { sku: 'crc2', amountCents: 15000 }, postings: hackwarePostings
};
assert.equal(hashMoneyRequest(request).length, 64);
assert.notEqual(hashMoneyRequest(request), hashMoneyRequest({ ...request, merchantKey: 'computerstore', postings: [
  hackwarePostings[0], { ...hackwarePostings[1], systemAccount: 'website_treasury:computerstore' }
] }), 'merchant attribution must be part of the idempotency fingerprint');
assert.equal(WEBSITE_MERCHANT_SEEDS.length, 2);
assert.deepEqual(WEBSITE_MERCHANT_SEEDS.map(row => row.merchantKey).sort(), ['computerstore', 'hackware']);

function makeFakeClient() {
  const txs = new Map();
  const postings = [];
  const assets = new Map();
  let nextAssetId = 1;
  return {
    txs, postings, assets,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT id FROM netshift_money_transactions WHERE idempotency_key=$1')) {
        const row = txs.get(params[0]); return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('SELECT id FROM netshift_money_postings WHERE bank_account_id=$1 LIMIT 1')) {
        const rows = postings.filter(row => String(row.bank_account_id) === String(params[0]));
        return rows.length ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('INSERT INTO netshift_money_transactions')) {
        const [id, key, type, actor, merchant, hash, metadata] = params;
        if (txs.has(key)) return { rows: [], rowCount: 0 };
        const row = { id, idempotency_key: key, transaction_type: type, actor_user_id: actor,
          merchant_key: merchant, request_hash: hash, metadata: JSON.parse(metadata), created_at: '2026-10-14T00:00:00Z' };
        txs.set(key, row);
        return { rows: [{ id, transaction_type: type, merchant_key: merchant, created_at: row.created_at }], rowCount: 1 };
      }
      if (q.startsWith('SELECT id, transaction_type, merchant_key, actor_user_id, request_hash, created_at FROM netshift_money_transactions')) {
        const row = txs.get(params[0]); return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('INSERT INTO netshift_money_postings')) {
        const [transaction_id, bank_account_id, account_owner_user_id, system_account, account_code, amount_cents] = params;
        postings.push({ transaction_id, bank_account_id, account_owner_user_id, system_account, account_code, amount_cents });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO netshift_asset_ledger')) {
        const [event_key, asset_id, asset_type, event_type, actor_user_id, owner_user_id, counterparty_user_id,
          from_path, to_path, money_transaction_id, details, request_hash] = params;
        if (assets.has(event_key)) return { rows: [], rowCount: 0 };
        const row = { id: nextAssetId++, event_key, asset_id, asset_type, event_type, actor_user_id,
          owner_user_id, counterparty_user_id, from_path, to_path, money_transaction_id,
          details: JSON.parse(details), request_hash, created_at: '2026-10-14T00:00:00Z' };
        assets.set(event_key, row); return { rows: [row], rowCount: 1 };
      }
      if (q.startsWith('SELECT id, event_key, asset_id, asset_type, event_type, created_at, request_hash FROM netshift_asset_ledger')) {
        const row = assets.get(params[0]); return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected economy ledger test SQL: ${q}`);
    }
  };
}

(async () => {
  const client = makeFakeClient();
  const baselineWritten = await ensureMoneyLedgerBaseline(client, { id: '601', owner_user_id: '101', balance_cents: 12000 });
  assert.equal(baselineWritten, true);
  const baselinePostings = client.postings.length;
  assert.equal(client.postings[baselinePostings - 2].amount_cents, 12000);
  assert.equal(client.postings[baselinePostings - 1].amount_cents, -12000);
  assert.equal(await ensureMoneyLedgerBaseline(client, { id: '601', owner_user_id: '101', balance_cents: 12000 }), false,
    'opening balance must be idempotent and must not be recorded twice');
  assert.equal(client.postings.length, baselinePostings);
  assert.equal(await ensureMoneyLedgerBaseline(client, { id: '602', owner_user_id: '202', balance_cents: 0 }), false,
    'zero opening balance does not require invalid zero-value postings');

  const first = await createMoneyTransaction(client, request);
  assert.equal(first.duplicate, false);
  const initialPostingCount = client.postings.length;
  const replay = await createMoneyTransaction(client, request);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal(client.postings.length, initialPostingCount, 'replays must not append extra postings');
  await assert.rejects(() => createMoneyTransaction(client, {
    ...request, idempotencyKey: 'unbalanced-new-request-01', metadata: { sku: 'crc2', amountCents: 15000 }, postings: [
      hackwarePostings[0], { ...hackwarePostings[1], amountCents: 14999 }
    ]
  }), error => error.code === 'LEDGER_NOT_BALANCED');
  await assert.rejects(() => createMoneyTransaction(client, {
    ...request, metadata: { sku: 'crc2', amountCents: 16000 }
  }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');

  const assetEvent = {
    eventKey: 'asset-purchase-event-0001', assetId: '00000000-0000-4000-8000-000000000501',
    assetType: 'software', eventType: 'purchase', actorUserId: '101', ownerUserId: '101',
    moneyTransactionId: first.id, fromPath: 'hack3rw4re.net', toPath: '/downloads',
    details: { softwareId: 'crc2', merchantKey: 'hackware' }
  };
  const createdAssetEvent = await recordAssetEvent(client, assetEvent);
  const assetReplay = await recordAssetEvent(client, assetEvent);
  assert.equal(assetReplay.id, createdAssetEvent.id);
  await assert.rejects(() => recordAssetEvent(client, {
    ...assetEvent, details: { softwareId: 'crc3', merchantKey: 'hackware' }
  }), error => error.code === 'ASSET_EVENT_KEY_REUSED');

  assert.ok(server.includes('await initialiseEconomyLedgerSchema(pool)'), 'server must install the E1 ledger schema during startup');
  assert.equal((server.match(/app\.(?:post|put|patch|delete)\(['"]\/api\/core\/economy\//g) || []).length, 0,
    'E1 must not accidentally enable economy action endpoints before the ledger PostgreSQL gate passes');
  for (const marker of [
    'netshift_money_transactions', 'netshift_money_postings', 'netshift_asset_ledger',
    'netshift_website_income_summary', 'netshift_money_transaction_balanced_header',
    'netshift_money_transaction_balanced_posting', 'netshift_money_transactions_append_only',
    'netshift_money_postings_append_only', 'netshift_asset_ledger_append_only'
  ]) assert.ok(ECONOMY_LEDGER_DDL.includes(marker), `E1 schema must provide: ${marker}`);
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS netshift_economy_merchants',
    'CREATE OR REPLACE FUNCTION netshift_assert_money_transaction_balanced',
    'CREATE OR REPLACE VIEW netshift_website_income_summary',
    'website_treasury:hackware', 'website_treasury:computerstore',
    'gross_income_cents', 'net_treasury_cents', 'ON DELETE RESTRICT'
  ]) assert.ok(ECONOMY_LEDGER_DDL.includes(marker) || guide.includes(marker), `E1 schema/docs must contain ${marker}`);
  assert.ok(packageJson.scripts.check.includes('node scripts/check-economy-ledger.js'));
  assert.equal(packageJson.scripts['test:economy:postgres'], 'node scripts/test-economy-ledger-postgres.js');
  assert.ok(guide.includes('does not yet implement purchase or transfer endpoints'), 'E1 must clearly defer economy APIs to later chunks');
  console.log('E1 economy ledger checks OK (balanced integer-cent postings, merchant attribution, idempotency fingerprints, immutable asset events, website revenue-account design and schema wiring). Real PostgreSQL constraints remain a separate opt-in test.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
