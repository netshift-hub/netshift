'use strict';

const crypto = require('node:crypto');

const MONEY_TRANSACTION_TYPES = new Set([
  'opening_balance', 'migration_baseline', 'player_transfer', 'software_purchase',
  'hardware_purchase', 'subscription', 'mission_reward', 'npc_loot', 'warez_cashout',
  'malware_theft', 'admin_adjustment', 'reversal', 'website_sale', 'website_refund',
  'website_income_payout', 'asset_sale', 'asset_refund', 'account_fee'
]);
const ASSET_TYPES = new Set(['file', 'software', 'folder']);
const ASSET_EVENT_TYPES = new Set([
  'create', 'edit', 'rename', 'move', 'install', 'archive', 'recycle', 'restore',
  'permanent_delete', 'claim', 'purchase', 'free_download', 'transfer', 'cashout'
]);
const MAX_METADATA_BYTES = 16 * 1024;

class EconomyLedgerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EconomyLedgerError';
    this.status = status;
    this.code = code;
  }
}

function validateIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{7,119}$/.test(value);
}

function normalisePostings(postings) {
  if (!Array.isArray(postings) || postings.length < 2 || postings.length > 20) {
    throw new EconomyLedgerError(400, 'LEDGER_POSTINGS_INVALID', 'A money transaction needs between 2 and 20 balanced postings.');
  }
  const normalised = postings.map(posting => {
    const amount = Number(posting?.amountCents);
    const bankAccountId = posting?.bankAccountId == null ? null : String(posting.bankAccountId);
    const accountOwnerUserId = posting?.accountOwnerUserId == null ? null : String(posting.accountOwnerUserId);
    const systemAccount = posting?.systemAccount == null ? null : String(posting.systemAccount);
    if (!Number.isSafeInteger(amount) || amount === 0) {
      throw new EconomyLedgerError(400, 'LEDGER_POSTINGS_INVALID', 'Each money posting must be a non-zero integer number of cents.');
    }
    if (bankAccountId !== null && (!/^\d+$/.test(bankAccountId) || !accountOwnerUserId || !/^\d+$/.test(accountOwnerUserId) || systemAccount)) {
      throw new EconomyLedgerError(400, 'LEDGER_POSTINGS_INVALID', 'Player-account postings must identify the bank account and owner only.');
    }
    if (bankAccountId === null && (!systemAccount || !/^[a-z][a-z0-9_:-]{1,99}$/i.test(systemAccount) || accountOwnerUserId)) {
      throw new EconomyLedgerError(400, 'LEDGER_POSTINGS_INVALID', 'Non-player postings must use a valid system account code.');
    }
    return { bankAccountId, accountOwnerUserId, systemAccount, amountCents: amount };
  });
  const sum = normalised.reduce((total, posting) => total + posting.amountCents, 0);
  if (!Number.isSafeInteger(sum) || sum !== 0) {
    throw new EconomyLedgerError(400, 'LEDGER_NOT_BALANCED', 'Money transaction postings must sum to exactly zero cents.');
  }
  return normalised;
}

function normaliseObject(value, fieldName) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new EconomyLedgerError(400, 'LEDGER_METADATA_INVALID', `${fieldName} must be an object.`);
  }
  let serialised;
  try { serialised = JSON.stringify(value); } catch (_) {
    throw new EconomyLedgerError(400, 'LEDGER_METADATA_INVALID', `${fieldName} must be JSON serialisable.`);
  }
  if (Buffer.byteLength(serialised || '{}', 'utf8') > MAX_METADATA_BYTES) {
    throw new EconomyLedgerError(400, 'LEDGER_METADATA_TOO_LARGE', `${fieldName} exceeds the ledger metadata limit.`);
  }
  return JSON.parse(serialised || '{}');
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalPostingSortKey(posting) {
  return [posting.bankAccountId || '', posting.accountOwnerUserId || '', posting.systemAccount || '', String(posting.amountCents).padStart(20, '0')].join(':');
}

function hashMoneyRequest({ transactionType, actorUserId, merchantKey, metadata, postings }) {
  const canonical = {
    transactionType,
    actorUserId: actorUserId == null ? null : String(actorUserId),
    merchantKey: merchantKey == null ? null : String(merchantKey),
    metadata: normaliseObject(metadata, 'Transaction metadata'),
    postings: normalisePostings(postings).slice().sort((a, b) => canonicalPostingSortKey(a).localeCompare(canonicalPostingSortKey(b)))
  };
  return crypto.createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function validateMerchantPosting(merchantKey, postings) {
  if (merchantKey == null) {
    if (postings.some(posting => posting.systemAccount?.startsWith('website_treasury:'))) {
      throw new EconomyLedgerError(400, 'MERCHANT_ATTRIBUTION_REQUIRED', 'A transaction posting to a website treasury must identify that merchant.');
    }
    return;
  }
  if (typeof merchantKey !== 'string' || !/^[a-z][a-z0-9_-]{1,59}$/.test(merchantKey)) {
    throw new EconomyLedgerError(400, 'MERCHANT_INVALID', 'The merchant key is invalid.');
  }
  const treasuryAccount = `website_treasury:${merchantKey}`;
  const matches = postings.filter(posting => posting.systemAccount === treasuryAccount);
  const anyWebsiteTreasury = postings.filter(posting => posting.systemAccount?.startsWith('website_treasury:'));
  if (matches.length !== 1 || anyWebsiteTreasury.length !== 1) {
    throw new EconomyLedgerError(400, 'MERCHANT_POSTING_INVALID', 'A merchant-attributed transaction must contain exactly one posting to that merchant’s treasury account.');
  }
}

/**
 * Record the bank account's current persisted balance as an opening-balance journal
 * entry before its first ledger-backed operation. Caller must already hold the bank
 * account row lock and have opened a transaction. This never changes the balance.
 * Zero-balance accounts need no zero-valued posting; once any ledger posting exists,
 * a later call will not incorrectly baseline the then-current balance a second time.
 */
async function ensureMoneyLedgerBaseline(client, account) {
  const bankAccountId = String(account?.id ?? '');
  const ownerUserId = String(account?.owner_user_id ?? account?.ownerUserId ?? '');
  const balanceCents = Number(account?.balance_cents ?? account?.balanceCents);
  if (!/^\d+$/.test(bankAccountId) || !/^\d+$/.test(ownerUserId) ||
      !Number.isSafeInteger(balanceCents) || balanceCents < 0) {
    throw new EconomyLedgerError(400, 'LEDGER_BASELINE_ACCOUNT_INVALID', 'Opening balance requires a valid locked bank-account row.');
  }
  const idempotencyKey = `baseline-bank-account:${bankAccountId}`;
  const existing = await client.query('SELECT id FROM netshift_money_transactions WHERE idempotency_key=$1', [idempotencyKey]);
  if (existing.rowCount) return false;
  const priorPostings = await client.query('SELECT id FROM netshift_money_postings WHERE bank_account_id=$1 LIMIT 1', [bankAccountId]);
  if (priorPostings.rowCount || balanceCents === 0) return false;
  const transaction = await createMoneyTransaction(client, {
    idempotencyKey,
    transactionType: 'opening_balance',
    actorUserId: null,
    metadata: { source: 'server-bank-account', currency: 'USD' },
    postings: [
      { bankAccountId, accountOwnerUserId: ownerUserId, amountCents: balanceCents },
      { bankAccountId: null, accountOwnerUserId: null, systemAccount: 'money_issuance', amountCents: -balanceCents }
    ]
  });
  return !transaction.duplicate;
}

/**
 * Insert one immutable transaction header and balanced postings. Caller must already
 * have opened a PostgreSQL transaction. Database deferred constraint triggers repeat
 * the balance and merchant-attribution checks at COMMIT, so the invariant is not only
 * dependent on this JavaScript helper.
 */
async function createMoneyTransaction(client, input) {
  const { idempotencyKey, transactionType, actorUserId = null, merchantKey = null } = input || {};
  const metadata = normaliseObject(input?.metadata, 'Transaction metadata');
  if (!MONEY_TRANSACTION_TYPES.has(transactionType)) {
    throw new EconomyLedgerError(400, 'LEDGER_TRANSACTION_TYPE_INVALID', 'Unsupported money transaction type.');
  }
  if (!validateIdempotencyKey(idempotencyKey)) {
    throw new EconomyLedgerError(400, 'IDEMPOTENCY_KEY_INVALID', 'Provide a valid idempotency key for this transaction.');
  }
  if (actorUserId != null && !/^\d+$/.test(String(actorUserId))) {
    throw new EconomyLedgerError(400, 'LEDGER_ACTOR_INVALID', 'Invalid ledger actor.');
  }
  const safePostings = normalisePostings(input?.postings);
  validateMerchantPosting(merchantKey, safePostings);
  const requestHash = hashMoneyRequest({ transactionType, actorUserId, merchantKey, metadata, postings: safePostings });
  const transactionId = crypto.randomUUID();
  const inserted = await client.query(`INSERT INTO netshift_money_transactions
      (id, idempotency_key, transaction_type, actor_user_id, merchant_key, request_hash, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, transaction_type, merchant_key, created_at`,
  [transactionId, idempotencyKey, transactionType, actorUserId, merchantKey, requestHash, JSON.stringify(metadata)]);

  if (!inserted.rowCount) {
    const existing = await client.query(`SELECT id, transaction_type, merchant_key, actor_user_id, request_hash, created_at
      FROM netshift_money_transactions WHERE idempotency_key=$1`, [idempotencyKey]);
    if (!existing.rowCount) throw new Error('Idempotency conflict occurred but the original money transaction could not be found.');
    if (existing.rows[0].request_hash !== requestHash) {
      throw new EconomyLedgerError(409, 'IDEMPOTENCY_KEY_REUSED', 'That transaction key has already been used for a different request.');
    }
    return {
      id: existing.rows[0].id,
      transactionType: existing.rows[0].transaction_type,
      merchantKey: existing.rows[0].merchant_key,
      createdAt: existing.rows[0].created_at,
      duplicate: true
    };
  }

  for (const posting of safePostings) {
    const accountCode = posting.bankAccountId !== null
      ? `player-bank:${posting.bankAccountId}`
      : `system:${posting.systemAccount}`;
    await client.query(`INSERT INTO netshift_money_postings
      (transaction_id, bank_account_id, account_owner_user_id, system_account, account_code, amount_cents)
      VALUES ($1,$2,$3,$4,$5,$6)`, [transactionId, posting.bankAccountId, posting.accountOwnerUserId,
      posting.systemAccount, accountCode, posting.amountCents]);
  }
  return { id: transactionId, transactionType, merchantKey, createdAt: inserted.rows[0].created_at, duplicate: false };
}

function normaliseAssetEvent(event) {
  const {
    eventKey = crypto.randomUUID(), assetId, assetType, eventType,
    actorUserId = null, ownerUserId = null, counterpartyUserId = null,
    fromPath = null, toPath = null, moneyTransactionId = null, details = {}
  } = event || {};
  if (!validateIdempotencyKey(eventKey)) throw new EconomyLedgerError(400, 'ASSET_EVENT_KEY_INVALID', 'Invalid asset event key.');
  if (typeof assetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId)) {
    throw new EconomyLedgerError(400, 'ASSET_ID_INVALID', 'Canonical asset events require a UUID asset identifier.');
  }
  if (!ASSET_TYPES.has(assetType) || !ASSET_EVENT_TYPES.has(eventType)) {
    throw new EconomyLedgerError(400, 'ASSET_EVENT_INVALID', 'Invalid asset event type.');
  }
  if (actorUserId != null && !/^\d+$/.test(String(actorUserId))) throw new EconomyLedgerError(400, 'ASSET_ACTOR_INVALID', 'Invalid asset actor.');
  if (ownerUserId != null && !/^\d+$/.test(String(ownerUserId))) throw new EconomyLedgerError(400, 'ASSET_OWNER_INVALID', 'Invalid asset owner.');
  if (counterpartyUserId != null && !/^\d+$/.test(String(counterpartyUserId))) throw new EconomyLedgerError(400, 'ASSET_COUNTERPARTY_INVALID', 'Invalid asset counterparty.');
  if (moneyTransactionId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(moneyTransactionId))) {
    throw new EconomyLedgerError(400, 'ASSET_MONEY_TRANSACTION_INVALID', 'Invalid linked money transaction ID.');
  }
  const safeDetails = normaliseObject(details, 'Asset event details');
  const payload = {
    eventKey, assetId: assetId.toLowerCase(), assetType, eventType,
    actorUserId: actorUserId == null ? null : String(actorUserId),
    ownerUserId: ownerUserId == null ? null : String(ownerUserId),
    counterpartyUserId: counterpartyUserId == null ? null : String(counterpartyUserId),
    fromPath: fromPath == null ? null : String(fromPath).slice(0, 500),
    toPath: toPath == null ? null : String(toPath).slice(0, 500),
    moneyTransactionId: moneyTransactionId == null ? null : String(moneyTransactionId),
    details: safeDetails
  };
  payload.requestHash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  return payload;
}

async function recordAssetEvent(client, event) {
  const payload = normaliseAssetEvent(event);
  const result = await client.query(`INSERT INTO netshift_asset_ledger
    (event_key, asset_id, asset_type, event_type, actor_user_id, owner_user_id, counterparty_user_id,
      from_path, to_path, money_transaction_id, details, request_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id, event_key, asset_id, asset_type, event_type, created_at, request_hash`,
  [payload.eventKey, payload.assetId, payload.assetType, payload.eventType, payload.actorUserId, payload.ownerUserId,
    payload.counterpartyUserId, payload.fromPath, payload.toPath, payload.moneyTransactionId, JSON.stringify(payload.details), payload.requestHash]);
  if (result.rowCount) {
    const { request_hash: ignoredHash, ...row } = result.rows[0];
    return row;
  }
  const prior = await client.query(`SELECT id, event_key, asset_id, asset_type, event_type, created_at, request_hash
    FROM netshift_asset_ledger WHERE event_key=$1`, [payload.eventKey]);
  if (!prior.rowCount || prior.rows[0].request_hash !== payload.requestHash) {
    throw new EconomyLedgerError(409, 'ASSET_EVENT_KEY_REUSED', 'That asset-event key has already been used for a different event.');
  }
  const { request_hash: ignoredHash, ...row } = prior.rows[0];
  return row;
}

module.exports = {
  EconomyLedgerError,
  MONEY_TRANSACTION_TYPES,
  ASSET_TYPES,
  ASSET_EVENT_TYPES,
  validateIdempotencyKey,
  normalisePostings,
  normaliseObject,
  stableStringify,
  hashMoneyRequest,
  validateMerchantPosting,
  ensureMoneyLedgerBaseline,
  createMoneyTransaction,
  normaliseAssetEvent,
  recordAssetEvent
};
