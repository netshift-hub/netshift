# NETSHIFT Economy E2 — First Bank transfers

**Status:** implementation prepared locally; deterministic checks pass. Real PostgreSQL and deployed two-account browser validation are pending.

## Scope

E2 implements player-to-player transfers through the existing First Bank API and E1 money ledger. It deliberately does not implement software purchases, merchant sales, upgrades, player rewards, Warez cashout or full economy migration.

### Server contract

- `POST /api/core/bank/transfers` sends money. It requires a current NETSHIFT account-owning session and an authenticated First Bank session.
- `GET /api/core/bank/transfers` lists the current account's 20 most recent player transfers only.
- Destination must be an eight-digit account number for another active player account which has completed First Bank setup. The endpoint does not return recipient names, balances, credentials or unrelated account activity.
- Amount accepts decimal USD notation only, up to two decimal places, and is converted to integer cents on the server. The request cannot submit balance values or ledger postings.
- The server locks sender and recipient rows in ascending bank-account ID order. It writes any required opening-balance baselines, the `player_transfer` transaction header and its balanced debit/credit postings, and the two materialized balance updates in one PostgreSQL transaction.
- Each request includes a sender-scoped idempotency key. An exact retry returns the original transaction; a changed request under the same key is rejected. A rollback leaves neither balance changes nor transaction postings.
- Transfers are rate-limited. Self-transfers, unavailable/unactivated destinations and insufficient funds are rejected.

## Required verification

1. Run `npm run check`.
2. Run `npm run test:economy:postgres` against a newly created disposable PostgreSQL database. This command never uses `DATABASE_URL`; it requires an explicit acknowledgement and builds a random temporary test schema.
3. Deploy only to the verified staging service after checking the branch and database connection.
4. Use two disposable players and verify outgoing/incoming balances, transfer history, retries, invalid requests, session boundaries, refresh/relogin and concurrent overspend.

A skipped PostgreSQL run is not a pass. Do not use the production database as a test target.

## Accounting model

The First Bank `balance_cents` is retained as a materialized balance projection for fast UI reads. E2 is the first operation wired so its balance mutation and immutable ledger posting are one transaction. Opening-balance postings document each existing nonzero balance before first ledger-backed use. As more economy operations are migrated, all balance-changing operations must use the same transaction pattern and reconciliation must compare account balances with posted ledger totals.

Website merchant treasury accounting from E1 is separate from player-to-player transfers. A player transfer does not count as revenue for `hack3rw4re.net` or `computerstore.net`; future merchant sales must be explicitly attributed to the correct merchant.
