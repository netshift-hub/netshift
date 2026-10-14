'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BankTransferError, parseTransferAmountCents, normaliseBankTransferRequest, transferFirstBankFunds
} = require('../lib/bank-transfer');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const transferService = fs.readFileSync(path.join(root, 'lib/bank-transfer.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const pgTests = fs.readFileSync(path.join(root, 'scripts/test-economy-ledger-postgres.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.equal(parseTransferAmountCents('0.01'), 1);
assert.equal(parseTransferAmountCents('25'), 2500);
assert.equal(parseTransferAmountCents('25.5'), 2550);
assert.equal(parseTransferAmountCents('99999999.99'), 9999999999);
for (const bad of ['', '0', '0.00', '-1', '+1', '1e3', '1.001', '1,000', '.99', '100000000', '  ']) {
  assert.throws(() => parseTransferAmountCents(bad), BankTransferError, `amount ${JSON.stringify(bad)} should be rejected`);
}
const normalised = normaliseBankTransferRequest({ recipientAccountNumber: '12345678', amount: '7.35', reference: 'Lunch', idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' });
assert.deepEqual(normalised, { recipientAccountNumber: '12345678', amountCents: 735, reference: 'Lunch', idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' });
assert.throws(() => normaliseBankTransferRequest({ recipientAccountNumber: '1234', amount: '1', reference: '', idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' }), e => e.code === 'RECIPIENT_ACCOUNT_INVALID');
assert.throws(() => normaliseBankTransferRequest({ recipientAccountNumber: '12345678', amount: '1', reference: 'x'.repeat(81), idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' }), e => e.code === 'TRANSFER_REFERENCE_INVALID');
assert.throws(() => normaliseBankTransferRequest({ recipientAccountNumber: '12345678', amount: '1', reference: '', idempotencyKey: 'short' }), e => e.code === 'TRANSFER_IDEMPOTENCY_KEY_INVALID');

for (const marker of [
  "app.post('/api/core/bank/transfers', bankTransferLimiter, requireAuth",
  "app.get('/api/core/bank/transfers'",
  'transferFirstBankFunds(client',
  'req.session.bankAuthenticatedFor !== String(req.session.user.id)',
  "WHERE owner_user_id=$1 OR account_number=$2",
  'ORDER BY id FOR UPDATE'
]) assert.ok(server.includes(marker) || transferService.includes(marker), `E2 route/service must include transfer guard/path: ${marker}`);
for (const marker of [
  "netshiftApi('/api/core/bank/transfers'",
  'netshiftBankSubmitTransfer()',
  'coreBankRecipientAccount',
  'coreBankTransferKey',
  'Recent transfers'
]) assert.ok(client.includes(marker), `First Bank UI must include transfer support: ${marker}`);
assert.ok(pgTests.includes('PG E2.'), 'PostgreSQL suite must include E2 integration cases');
assert.ok(packageJson.scripts.check.includes('node scripts/check-bank-transfer.js'));
assert.equal(packageJson.scripts['test:economy:postgres'], 'node scripts/test-economy-ledger-postgres.js');
function makeFakeTransferClient() {
  const state = {
    accounts: new Map([
      ['701', { id: '701', owner_user_id: '101', account_number: '12345678', account_username: 'sender', password_hash: 'hash', balance_cents: 10000, is_player: true }],
      ['702', { id: '702', owner_user_id: '202', account_number: '87654321', account_username: 'recipient', password_hash: 'hash', balance_cents: 3000, is_player: true }]
    ]),
    transactions: new Map(),
    postings: []
  };
  let snapshot = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    state,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN') {
        snapshot = { accounts: new Map([...state.accounts].map(([k,v]) => [k, clone(v)])), transactions: new Map([...state.transactions].map(([k,v]) => [k, clone(v)])), postings: clone(state.postings) };
        return { rows: [], rowCount: 0 };
      }
      if (q === 'COMMIT') { snapshot = null; return { rows: [], rowCount: 0 }; }
      if (q === 'ROLLBACK') {
        if (snapshot) {
          state.accounts = snapshot.accounts; state.transactions = snapshot.transactions; state.postings = snapshot.postings; snapshot = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith('SELECT id, owner_user_id, bank_code, account_number, account_username, password_hash, balance_cents, is_player FROM netshift_bank_accounts')) {
        const rows = [...state.accounts.values()].filter(row => String(row.owner_user_id) === String(params[0]) || String(row.account_number) === String(params[1])).sort((a,b) => Number(a.id)-Number(b.id)).map(clone);
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('SELECT id FROM netshift_money_transactions WHERE idempotency_key=$1')) {
        const row = state.transactions.get(params[0]); return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('SELECT id FROM netshift_money_postings WHERE bank_account_id=$1 LIMIT 1')) {
        const row = state.postings.find(posting => String(posting.bank_account_id) === String(params[0]));
        return row ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('INSERT INTO netshift_money_transactions')) {
        const [id, key, type, actor, merchant, hash, metadata] = params;
        if (state.transactions.has(key)) return { rows: [], rowCount: 0 };
        const row = { id, idempotency_key: key, transaction_type: type, actor_user_id: actor, merchant_key: merchant, request_hash: hash, metadata: JSON.parse(metadata), created_at: '2026-10-14T00:00:00.000Z' };
        state.transactions.set(key, row);
        return { rows: [{ id, transaction_type: type, merchant_key: merchant, created_at: row.created_at }], rowCount: 1 };
      }
      if (q.startsWith('SELECT id, transaction_type, merchant_key, actor_user_id, request_hash, created_at FROM netshift_money_transactions')) {
        const row = state.transactions.get(params[0]); return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('INSERT INTO netshift_money_postings')) {
        const [transaction_id, bank_account_id, account_owner_user_id, system_account, account_code, amount_cents] = params;
        state.postings.push({ transaction_id, bank_account_id: bank_account_id == null ? null : String(bank_account_id), account_owner_user_id: account_owner_user_id == null ? null : String(account_owner_user_id), system_account, account_code, amount_cents: Number(amount_cents) });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('UPDATE netshift_bank_accounts SET balance_cents=balance_cents-$2')) {
        const row = state.accounts.get(String(params[0]));
        if (!row || Number(row.balance_cents) < Number(params[1])) return { rows: [], rowCount: 0 };
        row.balance_cents -= Number(params[1]); return { rows: [{ balance_cents: row.balance_cents }], rowCount: 1 };
      }
      if (q.startsWith('UPDATE netshift_bank_accounts SET balance_cents=balance_cents+$2')) {
        const row = state.accounts.get(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.balance_cents += Number(params[1]); return { rows: [{ balance_cents: row.balance_cents }], rowCount: 1 };
      }
      throw new Error(`Unexpected mock transfer SQL: ${q}`);
    }
  };
}

(async () => {
  const fake = makeFakeTransferClient();
  const transferInput = { senderUserId: '101', recipientAccountNumber: '87654321', amountCents: 2500, reference: 'Mock transfer', idempotencyKey: 'e2-mock-transfer-001' };
  const first = await transferFirstBankFunds(fake, transferInput);
  assert.equal(first.duplicate, false);
  assert.deepEqual([fake.state.accounts.get('701').balance_cents, fake.state.accounts.get('702').balance_cents], [7500,5500]);
  assert.equal(fake.state.postings.filter(row => row.transaction_id === first.transactionId).length, 2);
  assert.equal(fake.state.postings.filter(row => row.transaction_id === first.transactionId).reduce((n,row) => n + row.amount_cents, 0), 0);
  const replay = await transferFirstBankFunds(fake, transferInput);
  assert.equal(replay.duplicate, true);
  assert.deepEqual([fake.state.accounts.get('701').balance_cents, fake.state.accounts.get('702').balance_cents], [7500,5500]);
  await assert.rejects(() => transferFirstBankFunds(fake, { ...transferInput, reference: 'Changed reference' }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(() => transferFirstBankFunds(fake, { ...transferInput, amountCents: 8000, reference: 'Too much', idempotencyKey: 'e2-mock-insufficient-01' }), error => error instanceof BankTransferError && error.code === 'INSUFFICIENT_FUNDS');
  assert.deepEqual([fake.state.accounts.get('701').balance_cents, fake.state.accounts.get('702').balance_cents], [7500,5500]);
  assert.equal(fake.state.transactions.has('bank-transfer:101:e2-mock-insufficient-01'), false, 'failed transfer must roll back its money transaction header');
  await assert.rejects(() => transferFirstBankFunds(fake, { ...transferInput, recipientAccountNumber: '12345678', idempotencyKey: 'e2-mock-self-transfer-01' }), error => error instanceof BankTransferError && error.code === 'SELF_TRANSFER_NOT_ALLOWED');
  console.log('E2 First Bank transfer checks OK (strict cents, atomic transfer helper, balanced postings, rollback, idempotency, session/route guards, UI, and PostgreSQL integration registration).');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
