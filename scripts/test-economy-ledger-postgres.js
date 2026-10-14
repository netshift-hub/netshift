'use strict';

// Opt-in, isolated-schema PostgreSQL integration tests for E1 ledgers and E2 First Bank transfers.
// It never reads DATABASE_URL, uses a clearly acknowledged disposable target,
// creates a random isolated schema, and drops only that schema when finished.
const assert = require('node:assert/strict');
const { initialiseEconomyLedgerSchema } = require('../lib/economy-ledger-schema');
const { ensureMoneyLedgerBaseline, createMoneyTransaction, recordAssetEvent } = require('../lib/economy-ledger');
const { transferFirstBankFunds, BankTransferError } = require('../lib/bank-transfer');

const URL_ENV = 'NETSHIFT_ECONOMY_TEST_DATABASE_URL';
const ACK_ENV = 'NETSHIFT_ECONOMY_TEST_DB_ACK';
const REMOTE_ACK_ENV = 'NETSHIFT_ECONOMY_ALLOW_REMOTE_TEST_DB';
const ACK_VALUE = 'I_CREATED_A_DISPOSABLE_DATABASE';
const REMOTE_ACK_VALUE = 'YES_I_CREATED_A_DISPOSABLE_POSTGRES_DATABASE';

function validateTestDatabaseUrl(value) {
  if (!value) return { skipped: true, reason: `${URL_ENV} is not set` };
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(`${URL_ENV} must be a valid PostgreSQL URL.`); }
  if (process.env.DATABASE_URL) {
    try {
      const applicationUrl = new URL(process.env.DATABASE_URL);
      const sameDatabase = parsed.hostname.toLowerCase() === applicationUrl.hostname.toLowerCase() &&
        decodeURIComponent(parsed.pathname) === decodeURIComponent(applicationUrl.pathname);
      if (value === process.env.DATABASE_URL || sameDatabase) {
        throw new Error(`Refusing to use the application database. Set ${URL_ENV} to a different disposable test database.`);
      }
    } catch (error) {
      if (error.message.startsWith('Refusing to use the application database')) throw error;
      throw new Error('Cannot safely compare the test URL with DATABASE_URL; use a separate local disposable test database.');
    }
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error(`${URL_ENV} must use postgres:// or postgresql://.`);
  if (process.env[ACK_ENV] !== ACK_VALUE) throw new Error(`Refusing to run without ${ACK_ENV}=${ACK_VALUE}.`);
  const host = parsed.hostname.toLowerCase();
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  const identity = `${host}/${dbName}`;
  if (/\.onrender\.com$|(^|\.)render\.com$/.test(host) || /(^|[.-])(main|prod|production|live)([.-]|$)/i.test(identity)) {
    throw new Error('Refusing a connection identity that appears to be a live/production service.');
  }
  if (!localHost && !/(test|testing|disposable|stage|staging|scratch|ci)/i.test(dbName)) {
    throw new Error('Remote database name must visibly identify it as test/disposable/staging/scratch/CI.');
  }
  if (!localHost && process.env[REMOTE_ACK_ENV] !== REMOTE_ACK_VALUE) {
    throw new Error(`Remote PostgreSQL is blocked by default. For a newly-created disposable remote database only, also set ${REMOTE_ACK_ENV}=${REMOTE_ACK_VALUE}.`);
  }
  return { skipped: false, localHost };
}

async function insertRawTransaction(client, { id, key, type = 'account_fee', merchantKey = null, hash = 'a'.repeat(64) }) {
  await client.query(`INSERT INTO netshift_money_transactions
    (id,idempotency_key,transaction_type,actor_user_id,merchant_key,request_hash,metadata)
    VALUES($1,$2,$3,101,$4,$5,'{}'::jsonb)`, [id, key, type, merchantKey, hash]);
}

async function main() {
  const validation = validateTestDatabaseUrl(process.env[URL_ENV]);
  if (validation.skipped) {
    console.log(`SKIP E1/E2 PostgreSQL economy integration tests: ${validation.reason}. No database connection was attempted.`);
    return;
  }

  const { Pool } = require('pg');
  const schema = `ns_e1_test_${process.pid}_${Date.now().toString(36)}`;
  const adminPool = new Pool({ connectionString: process.env[URL_ENV], max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const clientPool = new Pool({ connectionString: process.env[URL_ENV], max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  let schemaCreated = false;
  let client;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    client = await clientPool.connect();
    await client.query(`SET search_path TO "${schema}", public`);
    await initialiseEconomyLedgerSchema(client);
    await initialiseEconomyLedgerSchema(client); // re-entry must be safe/idempotent
    console.log('PG E1.1 PASS: ledger schema installation and merchant seeds are idempotent.');

    await client.query('BEGIN');
    const baselineCreated = await ensureMoneyLedgerBaseline(client, { id: '601', owner_user_id: '101', balance_cents: 12000 });
    assert.equal(baselineCreated, true);
    await client.query('COMMIT');
    await client.query('BEGIN');
    const baselineReplay = await ensureMoneyLedgerBaseline(client, { id: '601', owner_user_id: '101', balance_cents: 20000 });
    assert.equal(baselineReplay, false, 'a later balance must not be mis-recorded as an opening balance');
    const emptyBaseline = await ensureMoneyLedgerBaseline(client, { id: '602', owner_user_id: '202', balance_cents: 0 });
    assert.equal(emptyBaseline, false, 'zero balance does not generate zero-value postings');
    await client.query('COMMIT');
    const baselinePostings = await client.query(`SELECT amount_cents FROM netshift_money_postings WHERE bank_account_id=601 OR system_account='money_issuance' ORDER BY id`);
    assert.deepEqual(baselinePostings.rows.map(row => Number(row.amount_cents)), [12000, -12000]);
    console.log('PG E1.2 PASS: opening balance is recorded without changing balance state, and retry/current balances cannot create a second baseline.');

    const hackwareInput = {
      idempotencyKey: 'e1-sale-hackware-0001', transactionType: 'software_purchase', actorUserId: '101',
      merchantKey: 'hackware', metadata: { sku: 'crc2', priceCents: 15000 },
      postings: [
        { bankAccountId: '501', accountOwnerUserId: '101', amountCents: -15000 },
        { systemAccount: 'website_treasury:hackware', amountCents: 15000 }
      ]
    };
    await client.query('BEGIN');
    const hackware = await createMoneyTransaction(client, hackwareInput);
    await client.query('COMMIT');
    const postingTotal = await client.query('SELECT SUM(amount_cents)::bigint AS total, COUNT(*)::integer AS count FROM netshift_money_postings WHERE transaction_id=$1', [hackware.id]);
    assert.equal(Number(postingTotal.rows[0].total), 0);
    assert.equal(postingTotal.rows[0].count, 2);
    console.log('PG E1.3 PASS: balanced transaction and its postings commit together.');

    // Two offsetting late postings would keep an ordinary sum at zero, but must not
    // be allowed to alter the original immutable transaction after it has committed.
    await client.query('BEGIN');
    await client.query(`INSERT INTO netshift_money_postings
      (transaction_id,system_account,account_code,amount_cents)
      VALUES($1,'test_late_offset_a','system:test_late_offset_a',1000),
            ($1,'test_late_offset_b','system:test_late_offset_b',-1000)`, [hackware.id]);
    await assert.rejects(() => client.query('COMMIT'), error => error.code === '23514');
    await client.query('ROLLBACK').catch(() => {});
    const postingsAfterLateWrite = await client.query('SELECT COUNT(*)::integer AS count FROM netshift_money_postings WHERE transaction_id=$1', [hackware.id]);
    assert.equal(postingsAfterLateWrite.rows[0].count, 2);
    console.log('PG E1.4 PASS: even balanced offsetting postings cannot be appended to an already-committed transaction.');

    await client.query('BEGIN');
    const replay = await createMoneyTransaction(client, hackwareInput);
    await client.query('COMMIT');
    assert.equal(replay.duplicate, true);
    assert.equal(replay.id, hackware.id);
    const replayPostings = await client.query('SELECT COUNT(*)::integer AS count FROM netshift_money_postings WHERE transaction_id=$1', [hackware.id]);
    assert.equal(replayPostings.rows[0].count, 2);
    console.log('PG E1.5 PASS: retry with the same idempotency key returns the original transaction without duplicate postings.');

    await client.query('BEGIN');
    await assert.rejects(() => createMoneyTransaction(client, {
      ...hackwareInput, metadata: { sku: 'crc3', priceCents: 15000 }
    }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    await client.query('ROLLBACK');
    console.log('PG E1.6 PASS: idempotency key reuse with a different request is rejected.');

    // Submit an invalid transaction directly to SQL to prove the database, not only
    // JavaScript validation, enforces balance at COMMIT.
    await client.query('BEGIN');
    const unbalancedId = '00000000-0000-4000-8000-00000000e101';
    await insertRawTransaction(client, { id: unbalancedId, key: 'e1-unbalanced-0001' });
    await client.query(`INSERT INTO netshift_money_postings
      (transaction_id,bank_account_id,account_owner_user_id,account_code,amount_cents)
      VALUES($1,501,101,'player-bank:501',100)`, [unbalancedId]);
    await assert.rejects(() => client.query('COMMIT'), error => error.code === '23514');
    await client.query('ROLLBACK').catch(() => {});
    const absentBad = await client.query('SELECT id FROM netshift_money_transactions WHERE id=$1', [unbalancedId]);
    assert.equal(absentBad.rowCount, 0);
    console.log('PG E1.7 PASS: database deferred constraint rejects and rolls back an unbalanced transaction.');

    // The DB must reject a balanced transaction that attributes a hackware sale to
    // the computer-store treasury, even if somebody bypasses the JS helper.
    await client.query('BEGIN');
    const wrongMerchantId = '00000000-0000-4000-8000-00000000e102';
    await insertRawTransaction(client, { id: wrongMerchantId, key: 'e1-wrong-merchant-0001', type: 'software_purchase', merchantKey: 'hackware' });
    await client.query(`INSERT INTO netshift_money_postings
      (transaction_id,bank_account_id,account_owner_user_id,account_code,amount_cents)
      VALUES($1,503,101,'player-bank:503',-100)`, [wrongMerchantId]);
    await client.query(`INSERT INTO netshift_money_postings
      (transaction_id,system_account,account_code,amount_cents)
      VALUES($1,'website_treasury:computerstore','system:website_treasury:computerstore',100)`, [wrongMerchantId]);
    await assert.rejects(() => client.query('COMMIT'), error => error.code === '23514');
    await client.query('ROLLBACK').catch(() => {});
    assert.equal((await client.query('SELECT id FROM netshift_money_transactions WHERE id=$1', [wrongMerchantId])).rowCount, 0);
    console.log('PG E1.8 PASS: DB constraint rejects sales credited to a different website treasury.');

    const computerInput = {
      idempotencyKey: 'e1-sale-computerstore-0001', transactionType: 'hardware_purchase', actorUserId: '202',
      merchantKey: 'computerstore', metadata: { sku: 'network-adapter-1', priceCents: 4500 },
      postings: [
        { bankAccountId: '502', accountOwnerUserId: '202', amountCents: -4500 },
        { systemAccount: 'website_treasury:computerstore', amountCents: 4500 }
      ]
    };
    await client.query('BEGIN');
    const computer = await createMoneyTransaction(client, computerInput);
    await client.query('COMMIT');

    // A refund debits the same website treasury. Gross historical receipts stay intact;
    // net treasury falls, making both lifetime sales and remaining funds inspectable.
    await client.query('BEGIN');
    await createMoneyTransaction(client, {
      idempotencyKey: 'e1-refund-hackware-0001', transactionType: 'website_refund', actorUserId: '101',
      merchantKey: 'hackware', metadata: { originalTransactionId: hackware.id, refundCents: 1500 },
      postings: [
        { bankAccountId: '501', accountOwnerUserId: '101', amountCents: 1500 },
        { systemAccount: 'website_treasury:hackware', amountCents: -1500 }
      ]
    });
    await client.query('COMMIT');

    const income = await client.query(`SELECT merchant_key,gross_income_cents,net_treasury_cents,income_event_count
      FROM netshift_website_income_summary ORDER BY merchant_key`);
    const byMerchant = Object.fromEntries(income.rows.map(row => [row.merchant_key, row]));
    assert.equal(Number(byMerchant.hackware.gross_income_cents), 15000);
    assert.equal(Number(byMerchant.hackware.net_treasury_cents), 13500);
    assert.equal(Number(byMerchant.hackware.income_event_count), 1);
    assert.equal(Number(byMerchant.computerstore.gross_income_cents), 4500);
    assert.equal(Number(byMerchant.computerstore.net_treasury_cents), 4500);
    assert.equal(Number(byMerchant.computerstore.income_event_count), 1);
    console.log('PG E1.9 PASS: website income view separates merchants and distinguishes gross receipts from net treasury after a refund.');

    const assetId = '00000000-0000-4000-8000-00000000e201';
    const event = {
      eventKey: 'e1-asset-purchase-event-01', assetId, assetType: 'software', eventType: 'purchase',
      actorUserId: '101', ownerUserId: '101', moneyTransactionId: hackware.id,
      fromPath: 'hack3rw4re.net', toPath: '/downloads', details: { sku: 'crc2', merchantKey: 'hackware' }
    };
    const asset = await recordAssetEvent(client, event);
    const assetReplay = await recordAssetEvent(client, event);
    assert.equal(assetReplay.id, asset.id);
    await assert.rejects(() => recordAssetEvent(client, { ...event, details: { sku: 'crc3', merchantKey: 'hackware' } }), error => error.code === 'ASSET_EVENT_KEY_REUSED');
    console.log('PG E1.10 PASS: asset-provenance events are immutable/idempotent and link to the money transaction.');

    await assert.rejects(() => client.query('UPDATE netshift_money_transactions SET metadata=metadata WHERE id=$1', [hackware.id]), error => error.code === '55000');
    await assert.rejects(() => client.query('DELETE FROM netshift_money_postings WHERE transaction_id=$1', [hackware.id]), error => error.code === '55000');
    await assert.rejects(() => client.query('UPDATE netshift_asset_ledger SET details=details WHERE id=$1', [asset.id]), error => error.code === '55000');
    console.log('PG E1.11 PASS: the database rejects updates/deletes from money and asset ledgers.');

    const merchantCount = await client.query('SELECT COUNT(*)::integer AS count FROM netshift_economy_merchants');
    assert.equal(merchantCount.rows[0].count, 2);
    // Historical actor/owner IDs are snapshots, with no FK to netshift_users or bank accounts.
    const postingFk = await client.query(`SELECT COUNT(*)::integer AS count FROM information_schema.table_constraints
      WHERE constraint_schema=$1 AND table_name='netshift_money_postings' AND constraint_type='FOREIGN KEY'`, [schema]);
    assert.equal(postingFk.rows[0].count, 1, 'postings depend only on their immutable transaction header, not deletable user/bank rows');
    console.log('PG E1.12 PASS: journal references do not prevent deleting launch-disposable user/bank account records.');
    // E2 fixture accounts are created only inside this disposable test schema.
    // The production table has additional foreign keys, but the transfer service
    // depends only on this exact account contract.
    await client.query(`CREATE TABLE netshift_bank_accounts (
      id BIGINT PRIMARY KEY,
      owner_user_id BIGINT,
      bank_code VARCHAR(32) NOT NULL DEFAULT 'FIRST',
      account_number VARCHAR(24) NOT NULL UNIQUE,
      account_username VARCHAR(40) NOT NULL UNIQUE,
      password_hash TEXT,
      balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
      is_player BOOLEAN NOT NULL DEFAULT TRUE
    )`);
    await client.query(`INSERT INTO netshift_bank_accounts
      (id,owner_user_id,account_number,account_username,password_hash,balance_cents,is_player) VALUES
      (701,101,'12345678','e2_sender','fixture-hash',10000,TRUE),
      (702,202,'87654321','e2_recipient','fixture-hash',1000,TRUE),
      (703,303,'11112222','e2_concurrent_sender','fixture-hash',2500,TRUE),
      (704,404,'22223333','e2_concurrent_recipient','fixture-hash',0,TRUE),
      (705,505,'33334444','e2_unactivated','',0,TRUE)`);

    const transferInput = {
      senderUserId: '101', recipientAccountNumber: '87654321', amountCents: 2500,
      reference: 'E2 test transfer', idempotencyKey: 'e2-transfer-main-0001'
    };
    const transfer = await transferFirstBankFunds(client, transferInput);
    assert.equal(transfer.duplicate, false);
    assert.equal(transfer.senderBalanceCents, 7500);
    assert.equal(transfer.recipientBalanceCents, 3500);
    const transferPostings = await client.query(`SELECT COUNT(*)::integer AS count,
        SUM(amount_cents)::bigint AS total
      FROM netshift_money_postings WHERE transaction_id=$1`, [transfer.transactionId]);
    assert.equal(transferPostings.rows[0].count, 2);
    assert.equal(Number(transferPostings.rows[0].total), 0);
    const transferTx = await client.query('SELECT transaction_type, metadata FROM netshift_money_transactions WHERE id=$1', [transfer.transactionId]);
    assert.equal(transferTx.rows[0].transaction_type, 'player_transfer');
    assert.equal(transferTx.rows[0].metadata.reference, 'E2 test transfer');
    const senderHistory = await client.query(`SELECT CASE WHEN p.amount_cents < 0 THEN 'sent' ELSE 'received' END AS direction,
        CASE WHEN p.amount_cents < 0 THEN tx.metadata->>'recipientAccountNumber' ELSE tx.metadata->>'senderAccountNumber' END AS counterparty,
        ABS(p.amount_cents)::bigint AS amount_cents, tx.metadata->>'reference' AS reference
      FROM netshift_money_transactions tx JOIN netshift_money_postings p ON p.transaction_id=tx.id
      WHERE tx.id=$1 AND p.bank_account_id=701`, [transfer.transactionId]);
    const recipientHistory = await client.query(`SELECT CASE WHEN p.amount_cents < 0 THEN 'sent' ELSE 'received' END AS direction,
        CASE WHEN p.amount_cents < 0 THEN tx.metadata->>'recipientAccountNumber' ELSE tx.metadata->>'senderAccountNumber' END AS counterparty,
        ABS(p.amount_cents)::bigint AS amount_cents, tx.metadata->>'reference' AS reference
      FROM netshift_money_transactions tx JOIN netshift_money_postings p ON p.transaction_id=tx.id
      WHERE tx.id=$1 AND p.bank_account_id=702`, [transfer.transactionId]);
    assert.deepEqual(senderHistory.rows.map(row => [row.direction, row.counterparty, Number(row.amount_cents), row.reference]), [['sent','87654321',2500,'E2 test transfer']]);
    assert.deepEqual(recipientHistory.rows.map(row => [row.direction, row.counterparty, Number(row.amount_cents), row.reference]), [['received','12345678',2500,'E2 test transfer']]);
    console.log('PG E2.1 PASS: transfer debits and credits the two player balances with exactly two balanced ledger postings in one transaction; sent/received history is correctly scoped.');

    const replayTransfer = await transferFirstBankFunds(client, transferInput);
    assert.equal(replayTransfer.duplicate, true);
    assert.equal(replayTransfer.transactionId, transfer.transactionId);
    const replayBalances = await client.query('SELECT id,balance_cents FROM netshift_bank_accounts WHERE id IN (701,702) ORDER BY id');
    assert.deepEqual(replayBalances.rows.map(row => Number(row.balance_cents)), [7500,3500]);
    assert.equal((await client.query('SELECT COUNT(*)::integer AS count FROM netshift_money_transactions WHERE idempotency_key=$1', ['bank-transfer:101:e2-transfer-main-0001'])).rows[0].count, 1);
    for (const changedRequest of [
      { ...transferInput, reference: 'Altered replay' },
      { ...transferInput, amountCents: 2600 },
      { ...transferInput, recipientAccountNumber: '11112222' }
    ]) {
      await assert.rejects(() => transferFirstBankFunds(client, changedRequest), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    }
    const initialReconciliation = await client.query(`SELECT b.id, b.balance_cents,
        COALESCE(SUM(p.amount_cents),0)::bigint AS ledger_balance
      FROM netshift_bank_accounts b LEFT JOIN netshift_money_postings p ON p.bank_account_id=b.id
      WHERE b.id IN (701,702) GROUP BY b.id,b.balance_cents ORDER BY b.id`);
    assert.deepEqual(initialReconciliation.rows.map(row => [Number(row.balance_cents), Number(row.ledger_balance)]), [[7500,7500],[3500,3500]]);
    console.log('PG E2.2 PASS: exact retry creates no second payment, changed-request key reuse is rejected, and both balances reconcile to ledger postings.');

    await assert.rejects(() => transferFirstBankFunds(client, {
      ...transferInput, amountCents: 8000, reference: 'Too much', idempotencyKey: 'e2-transfer-insufficient-01'
    }), error => error instanceof BankTransferError && error.code === 'INSUFFICIENT_FUNDS');
    const insufficientBalances = await client.query('SELECT id,balance_cents FROM netshift_bank_accounts WHERE id IN (701,702) ORDER BY id');
    assert.deepEqual(insufficientBalances.rows.map(row => Number(row.balance_cents)), [7500,3500]);
    assert.equal((await client.query("SELECT COUNT(*)::integer AS count FROM netshift_money_transactions WHERE idempotency_key='bank-transfer:101:e2-transfer-insufficient-01'")).rows[0].count, 0);
    await assert.rejects(() => transferFirstBankFunds(client, {
      ...transferInput, recipientAccountNumber: '12345678', idempotencyKey: 'e2-transfer-self-0001'
    }), error => error instanceof BankTransferError && error.code === 'SELF_TRANSFER_NOT_ALLOWED');
    await assert.rejects(() => transferFirstBankFunds(client, {
      ...transferInput, recipientAccountNumber: '33334444', idempotencyKey: 'e2-transfer-unactivated-001'
    }), error => error instanceof BankTransferError && error.code === 'RECIPIENT_ACCOUNT_UNAVAILABLE');
    console.log('PG E2.3 PASS: insufficient funds, self-transfers and unactivated/unavailable destination accounts are rejected without balance changes.');

    const transferPool = new Pool({
      connectionString: process.env[URL_ENV], max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000,
      options: `-c search_path=${schema},public`
    });
    try {
      const concurrentInput = key => ({
        senderUserId: '303', recipientAccountNumber: '22223333', amountCents: 2000,
        reference: 'Concurrent E2 test', idempotencyKey: key
      });
      const runConcurrentTransfer = async input => {
        const concurrentClient = await transferPool.connect();
        try { return await transferFirstBankFunds(concurrentClient, input); }
        finally { concurrentClient.release(); }
      };
      const concurrent = await Promise.allSettled([
        runConcurrentTransfer(concurrentInput('e2-concurrent-transfer-A')),
        runConcurrentTransfer(concurrentInput('e2-concurrent-transfer-B'))
      ]);
      assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
      const rejection = concurrent.find(row => row.status === 'rejected');
      assert.ok(rejection && rejection.reason instanceof BankTransferError && rejection.reason.code === 'INSUFFICIENT_FUNDS');
      const concurrentBalances = await client.query('SELECT id,balance_cents FROM netshift_bank_accounts WHERE id IN (703,704) ORDER BY id');
      assert.deepEqual(concurrentBalances.rows.map(row => Number(row.balance_cents)), [500,2000]);
      const concurrentTx = await client.query(`SELECT COUNT(*)::integer AS count
        FROM netshift_money_transactions WHERE transaction_type='player_transfer'
          AND actor_user_id=303 AND metadata->>'reference'='Concurrent E2 test'`);
      assert.equal(concurrentTx.rows[0].count, 1);
      const concurrentReconciliation = await client.query(`SELECT b.id, b.balance_cents,
          COALESCE(SUM(p.amount_cents),0)::bigint AS ledger_balance
        FROM netshift_bank_accounts b LEFT JOIN netshift_money_postings p ON p.bank_account_id=b.id
        WHERE b.id IN (703,704) GROUP BY b.id,b.balance_cents ORDER BY b.id`);
      assert.deepEqual(concurrentReconciliation.rows.map(row => [Number(row.balance_cents), Number(row.ledger_balance)]), [[500,500],[2000,2000]]);
      console.log('PG E2.4 PASS: concurrent transfers lock balances in account-ID order; only one oversubscribing transfer can succeed and balances reconcile to the ledger.');
    } finally { await transferPool.end().catch(() => {}); }
    console.log('E2 PostgreSQL transfer integration tests PASS (4 checks).');
    console.log('E1 PostgreSQL integration tests PASS (12 checks).');
  } finally {
    if (client) client.release();
    await clientPool.end().catch(() => {});
    if (schemaCreated) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(error => console.error('Could not clean up the isolated E1 test schema:', error.message));
    await adminPool.end().catch(() => {});
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
