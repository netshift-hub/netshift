'use strict';

// Idempotent E1 schema installer. No existing player/account/file rows are read,
// rewritten, migrated, or deleted. Ledger actor/owner IDs are historical snapshots,
// intentionally not cascading foreign keys, so later account deletion cannot erase
// immutable economy history. Website merchants are deactivated, not deleted.

const WEBSITE_MERCHANT_SEEDS = Object.freeze([
  {
    merchantKey: 'hackware',
    displayName: 'hack3rw4re',
    websiteDomain: 'hack3rw4re.net',
    treasurySystemAccount: 'website_treasury:hackware'
  },
  {
    merchantKey: 'computerstore',
    displayName: 'PC Upgrade Depot',
    websiteDomain: 'computerstore.net',
    treasurySystemAccount: 'website_treasury:computerstore'
  }
]);

const ECONOMY_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS netshift_economy_merchants (
    merchant_key VARCHAR(60) PRIMARY KEY CHECK (merchant_key ~ '^[a-z][a-z0-9_-]{1,59}$'),
    display_name VARCHAR(120) NOT NULL,
    website_domain VARCHAR(120) NOT NULL UNIQUE,
    treasury_system_account VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (treasury_system_account = 'website_treasury:' || merchant_key)
  );

  CREATE TABLE IF NOT EXISTS netshift_money_transactions (
    id UUID PRIMARY KEY,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,119}$'),
    transaction_type VARCHAR(40) NOT NULL CHECK (transaction_type IN (
      'opening_balance','migration_baseline','player_transfer','software_purchase',
      'hardware_purchase','subscription','mission_reward','npc_loot','warez_cashout',
      'malware_theft','admin_adjustment','reversal','website_sale','website_refund',
      'website_income_payout','asset_sale','asset_refund','account_fee'
    )),
    actor_user_id BIGINT,
    merchant_key VARCHAR(60) REFERENCES netshift_economy_merchants(merchant_key) ON DELETE RESTRICT,
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS netshift_money_transactions_created_idx
    ON netshift_money_transactions (created_at DESC, id);
  CREATE INDEX IF NOT EXISTS netshift_money_transactions_actor_idx
    ON netshift_money_transactions (actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS netshift_money_transactions_merchant_idx
    ON netshift_money_transactions (merchant_key, created_at DESC) WHERE merchant_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS netshift_money_postings (
    id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES netshift_money_transactions(id) ON DELETE RESTRICT,
    -- These IDs are immutable historical references, deliberately not FKs: deleting a
    -- launch-disposable user/bank account must not rewrite or erase the accounting record.
    bank_account_id BIGINT,
    account_owner_user_id BIGINT,
    system_account VARCHAR(100),
    account_code VARCHAR(180) NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (bank_account_id IS NOT NULL AND account_owner_user_id IS NOT NULL AND system_account IS NULL
        AND account_code = 'player-bank:' || bank_account_id::text)
      OR
      (bank_account_id IS NULL AND account_owner_user_id IS NULL AND system_account IS NOT NULL
        AND system_account ~ '^[a-z][a-z0-9_:-]{1,99}$'
        AND account_code = 'system:' || system_account)
    )
  );
  CREATE INDEX IF NOT EXISTS netshift_money_postings_transaction_idx
    ON netshift_money_postings (transaction_id, id);
  CREATE INDEX IF NOT EXISTS netshift_money_postings_bank_account_idx
    ON netshift_money_postings (bank_account_id, created_at DESC) WHERE bank_account_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS netshift_money_postings_system_account_idx
    ON netshift_money_postings (system_account, created_at DESC) WHERE system_account IS NOT NULL;

  CREATE TABLE IF NOT EXISTS netshift_asset_ledger (
    id BIGSERIAL PRIMARY KEY,
    event_key VARCHAR(120) NOT NULL UNIQUE CHECK (event_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,119}$'),
    asset_id UUID NOT NULL,
    asset_type VARCHAR(16) NOT NULL CHECK (asset_type IN ('file','software','folder')),
    event_type VARCHAR(24) NOT NULL CHECK (event_type IN (
      'create','edit','rename','move','install','archive','recycle','restore',
      'permanent_delete','claim','purchase','free_download','transfer','cashout'
    )),
    -- Historical ID snapshots remain meaningful to audit logs even after user/file deletion.
    actor_user_id BIGINT,
    owner_user_id BIGINT,
    counterparty_user_id BIGINT,
    from_path VARCHAR(500),
    to_path VARCHAR(500),
    money_transaction_id UUID REFERENCES netshift_money_transactions(id) ON DELETE RESTRICT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS netshift_asset_ledger_asset_idx
    ON netshift_asset_ledger (asset_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS netshift_asset_ledger_owner_idx
    ON netshift_asset_ledger (owner_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS netshift_asset_ledger_counterparty_idx
    ON netshift_asset_ledger (counterparty_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS netshift_asset_ledger_money_tx_idx
    ON netshift_asset_ledger (money_transaction_id) WHERE money_transaction_id IS NOT NULL;

  CREATE OR REPLACE FUNCTION netshift_assert_money_transaction_balanced(p_transaction_id UUID)
  RETURNS VOID LANGUAGE plpgsql AS $$
  DECLARE
    v_merchant_key VARCHAR(60);
    v_transaction_xmin XID;
    v_merchant_treasury VARCHAR(100);
    v_posting_count BIGINT;
    v_posting_total NUMERIC;
    v_postings_from_other_transactions BIGINT;
    v_treasury_postings BIGINT;
    v_wrong_treasury_postings BIGINT;
  BEGIN
    SELECT merchant_key, xmin INTO v_merchant_key, v_transaction_xmin
      FROM netshift_money_transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Money transaction % does not exist', p_transaction_id USING ERRCODE = '23503';
    END IF;
    SELECT COUNT(*), COALESCE(SUM(amount_cents), 0),
      COUNT(*) FILTER (WHERE p.xmin <> v_transaction_xmin)
      INTO v_posting_count, v_posting_total, v_postings_from_other_transactions
      FROM netshift_money_postings p WHERE p.transaction_id = p_transaction_id;
    IF v_postings_from_other_transactions > 0 THEN
      RAISE EXCEPTION 'Postings for money transaction % must be inserted atomically with its header', p_transaction_id USING ERRCODE = '23514';
    END IF;
    IF v_posting_count < 2 OR v_posting_total <> 0 THEN
      RAISE EXCEPTION 'Money transaction % must contain at least two postings summing to zero; count %, sum %',
        p_transaction_id, v_posting_count, v_posting_total USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*) INTO v_treasury_postings FROM netshift_money_postings
      WHERE transaction_id = p_transaction_id AND system_account LIKE 'website_treasury:%';
    IF v_merchant_key IS NULL AND v_treasury_postings > 0 THEN
      RAISE EXCEPTION 'Website treasury posting requires merchant attribution for transaction %', p_transaction_id USING ERRCODE = '23514';
    END IF;
    IF v_merchant_key IS NOT NULL THEN
      SELECT treasury_system_account INTO v_merchant_treasury
        FROM netshift_economy_merchants WHERE merchant_key = v_merchant_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown merchant % for transaction %', v_merchant_key, p_transaction_id USING ERRCODE = '23503';
      END IF;
      SELECT COUNT(*) INTO v_treasury_postings FROM netshift_money_postings
        WHERE transaction_id = p_transaction_id AND system_account = v_merchant_treasury;
      SELECT COUNT(*) INTO v_wrong_treasury_postings FROM netshift_money_postings
        WHERE transaction_id = p_transaction_id AND system_account LIKE 'website_treasury:%'
          AND system_account <> v_merchant_treasury;
      IF v_treasury_postings <> 1 OR v_wrong_treasury_postings <> 0 THEN
        RAISE EXCEPTION 'Merchant transaction % must have exactly one posting to treasury % and none to other website treasuries',
          p_transaction_id, v_merchant_treasury USING ERRCODE = '23514';
      END IF;
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION netshift_check_money_transaction_balance_trigger()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE v_transaction_id UUID;
  BEGIN
    IF TG_TABLE_NAME = 'netshift_money_transactions' THEN
      v_transaction_id := NEW.id;
    ELSE
      v_transaction_id := NEW.transaction_id;
    END IF;
    PERFORM netshift_assert_money_transaction_balanced(v_transaction_id);
    RETURN NULL;
  END;
  $$;
  DROP TRIGGER IF EXISTS netshift_money_transaction_balanced_header ON netshift_money_transactions;
  CREATE CONSTRAINT TRIGGER netshift_money_transaction_balanced_header
    AFTER INSERT ON netshift_money_transactions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION netshift_check_money_transaction_balance_trigger();
  DROP TRIGGER IF EXISTS netshift_money_transaction_balanced_posting ON netshift_money_postings;
  CREATE CONSTRAINT TRIGGER netshift_money_transaction_balanced_posting
    AFTER INSERT ON netshift_money_postings DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION netshift_check_money_transaction_balance_trigger();

  CREATE OR REPLACE FUNCTION netshift_reject_ledger_update_delete()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Table % is append-only; write a compensating transaction/event instead', TG_TABLE_NAME
      USING ERRCODE = '55000';
    RETURN NULL; -- unreachable; RAISE EXCEPTION always aborts the statement.
  END;
  $$;
  DROP TRIGGER IF EXISTS netshift_money_transactions_append_only ON netshift_money_transactions;
  CREATE TRIGGER netshift_money_transactions_append_only BEFORE UPDATE OR DELETE ON netshift_money_transactions
    FOR EACH ROW EXECUTE FUNCTION netshift_reject_ledger_update_delete();
  DROP TRIGGER IF EXISTS netshift_money_postings_append_only ON netshift_money_postings;
  CREATE TRIGGER netshift_money_postings_append_only BEFORE UPDATE OR DELETE ON netshift_money_postings
    FOR EACH ROW EXECUTE FUNCTION netshift_reject_ledger_update_delete();
  DROP TRIGGER IF EXISTS netshift_asset_ledger_append_only ON netshift_asset_ledger;
  CREATE TRIGGER netshift_asset_ledger_append_only BEFORE UPDATE OR DELETE ON netshift_asset_ledger
    FOR EACH ROW EXECUTE FUNCTION netshift_reject_ledger_update_delete();

  -- Revenue is derived from posted sales to each website's own treasury account. Gross
  -- income counts positive receipts; net treasury subtracts refunds/payouts posted back
  -- out. No duplicate mutable revenue counter can drift away from the ledger.
  CREATE OR REPLACE VIEW netshift_website_income_summary AS
    SELECT m.merchant_key, m.display_name, m.website_domain, m.is_active,
      COALESCE(SUM(p.amount_cents) FILTER (WHERE p.amount_cents > 0), 0)::BIGINT AS gross_income_cents,
      COALESCE(SUM(p.amount_cents), 0)::BIGINT AS net_treasury_cents,
      (COUNT(DISTINCT p.transaction_id) FILTER (WHERE p.amount_cents > 0))::BIGINT AS income_event_count,
      MAX(tx.created_at) FILTER (WHERE p.amount_cents > 0) AS last_income_at
    FROM netshift_economy_merchants m
    LEFT JOIN netshift_money_transactions tx ON tx.merchant_key = m.merchant_key
    LEFT JOIN netshift_money_postings p ON p.transaction_id = tx.id
      AND p.system_account = m.treasury_system_account
    GROUP BY m.merchant_key, m.display_name, m.website_domain, m.is_active;
`;

async function initialiseEconomyLedgerSchema(db) {
  await db.query(ECONOMY_LEDGER_DDL);
  for (const merchant of WEBSITE_MERCHANT_SEEDS) {
    await db.query(`INSERT INTO netshift_economy_merchants
      (merchant_key, display_name, website_domain, treasury_system_account)
      VALUES ($1,$2,$3,$4) ON CONFLICT (merchant_key) DO NOTHING`,
    [merchant.merchantKey, merchant.displayName, merchant.websiteDomain, merchant.treasurySystemAccount]);
  }
}

module.exports = { WEBSITE_MERCHANT_SEEDS, ECONOMY_LEDGER_DDL, initialiseEconomyLedgerSchema };
