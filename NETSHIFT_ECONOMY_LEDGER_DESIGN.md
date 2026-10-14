# NETSHIFT Economy Foundation — E1 Ledger Design

## Scope

E1 creates the accounting foundation only. It does **not yet implement purchase, transfer, cashout, reward, paid-trade, or other economy action endpoints**. Those must be added as later vertical slices that use the ledger in the same PostgreSQL transaction as the balance/asset change.

## Accounting model

- All amounts are integer cents; decimal currency values must never be used for accounting arithmetic.
- Each money transaction has an immutable header, a caller-supplied idempotency key, a SHA-256 request fingerprint, optional actor snapshot, optional merchant key, and JSON object metadata.
- Each transaction must have at least two postings, each non-zero, whose integer-cent amounts sum to zero. A deferred PostgreSQL constraint trigger checks this at commit, even if an internal caller bypasses the JavaScript helper. It also checks PostgreSQL row `xmin` so all postings must be inserted in the same database transaction as their header; later inserts cannot rewrite an old transaction by adding offsetting postings.
- The application convention is signed postings: a player's account debit is negative and credit is positive. A sale credits its website treasury system account and debits the purchaser's bank account.
- A retry with the same idempotency key and exact request returns the original transaction; a retry with altered values is rejected. The caller must still avoid re-applying materialised balance changes when `duplicate` is true.
- Ledger headers, postings and asset events are append-only at the database layer. Correct an accounting mistake using a compensating transaction/event, never update or delete an old entry.
- `ensureMoneyLedgerBaseline(client, lockedAccount)` can be called inside a later money-changing action, after locking the account and before any transaction work. It records a non-zero pre-ledger balance as an `opening_balance` transaction without changing the bank balance. A zero-balance account needs no zero-valued postings, and any existing bank posting prevents the helper from baselining a later balance a second time. The helper is not called automatically at startup or against current accounts by E1.
- Bank account, user and asset IDs stored in journals are historical identifiers rather than cascading foreign keys. This allows launch-disposable accounts and their current records to be deleted without destroying economy history. Ledger transaction relationships themselves are protected by foreign keys.
- Metadata must be JSON-serialisable object data. Never include passwords, password hashes, session IDs/cookies, reset tokens, secrets, or full account credentials in ledger metadata.

## Journal tables

### `netshift_money_transactions`

Immutable transaction header with unique `idempotency_key`, transaction type, optional actor and merchant, request hash, metadata, and database timestamp.

### `netshift_money_postings`

Immutable signed integer-cent postings. Each row targets exactly one player bank account snapshot or system account. The transaction header is a protected foreign-key parent; player/bank IDs in the posting remain historical snapshots without foreign keys to rows that may later be removed.

### `netshift_asset_ledger`

Immutable, idempotent provenance events for canonical file/software/folder IDs: creation, edit, rename, move, install/archive, recycle/restore, deletion, claim, purchase, free download, transfer or cashout. Events may reference a money transaction. IDs and paths are historical snapshots, not ownership authority; `netshift_player_files` remains the current ownership authority until an explicit asset registry design changes that.

## Website income accounting

`netshift_economy_merchants` registers the virtual websites that act as sellers. E1 seeds:

| Merchant key | Website | Treasury account |
|---|---|---|
| `hackware` | `hack3rw4re.net` | `website_treasury:hackware` |
| `computerstore` | `computerstore.net` (PC Upgrade Depot) | `website_treasury:computerstore` |

A later sale must set `merchant_key` on the money transaction and post the seller's share/receipt to exactly that website's `website_treasury:<merchant_key>` system account. A database constraint enforces that the merchant attribution matches the treasury posting. This prevents sales at different shops from being merged into one generic shop-revenue number.

The `netshift_website_income_summary` view derives per-website totals from immutable posted entries rather than a duplicated counter:

- `gross_income_cents`: sum of positive receipts posted to the website treasury.
- `net_treasury_cents`: signed net amount held in the website treasury after any negative postings/refunds/payouts.
- `income_event_count`: number of transactions which posted a positive treasury receipt.
- `last_income_at`: most recent positive receipt timestamp.

No income is recorded merely because the table/view exists. E1 records **zero current business income** until a later purchase/sale endpoint posts real transactions to the website treasury. This supports future mechanisms in which a player who owns/controls a website could earn a share of its sales, without deciding that game design now or crediting players with unearned money.

The current frontend's legacy shops and their product catalogue are not yet fully authoritative. E1 does not claim a website purchase flow works online; E3 will implement the first real sale route and link it to this journal.

## Safe deletion and launch reset

Ledger snapshots deliberately do not cascade from users, accounts, or player-file rows. Merchant records are deactivated (`is_active = FALSE`) rather than deleted once they have transactions, and transaction/asset journals are not reset as a runtime feature. The planned fresh launch database can discard the entire pre-launch database under a separate launch procedure. Do not truncate ledgers or use production for integration tests.

## Acceptance gates

- Fast deterministic tests run under `npm run check`.
- `npm run test:economy:postgres` is opt-in and uses only `NETSHIFT_ECONOMY_TEST_DATABASE_URL` with explicit disposable-database acknowledgement. It creates one randomly named schema and drops only that schema.
- PostgreSQL tests cover idempotent schema installation, balanced commit constraints, idempotency/replay, merchant attribution, per-website income aggregation, append-only enforcement and asset-event provenance.
- The database integration suite was not executed as part of E1 packaging unless its output is explicitly recorded in the checkpoint. A skipped test is not a pass.

E1 does not yet implement purchase or transfer endpoints. Later chunks will introduce those endpoints only after real PostgreSQL validation of the journal foundation.
