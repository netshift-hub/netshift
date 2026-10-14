# NETSHIFT E2 checkpoint — First Bank transfers

**Prepared:** 2026-10-14
**Status:** local implementation complete; real PostgreSQL and browser/staging acceptance not yet run.

## Implemented

- `lib/bank-transfer.js` validates amounts/references/recipient account numbers and executes player transfers in a single database transaction.
- `POST /api/core/bank/transfers` and `GET /api/core/bank/transfers` enforce NETSHIFT session ownership and First Bank session authentication.
- Sender and recipient rows are locked in account ID order. Opening-balance baseline, balanced ledger postings, source debit, recipient credit and immutable transfer metadata are committed or rolled back together.
- Sender-scoped idempotency prevents duplicate payment after request retry and rejects changed request details under an existing key.
- Insufficient funds, self-transfers, unactivated/unknown recipients, invalid amount/reference/key and missing bank setup are rejected. Transfer sends are rate-limited.
- First Bank UI supports sending to an eight-digit player account and displays recent incoming/outgoing activity.
- Added `scripts/check-bank-transfer.js` to `npm run check` and E2 transaction, retry, reconciliation, failure and concurrent overspend cases to `scripts/test-economy-ledger-postgres.js`.
- Documentation and staging checklist updated.

## Local validation

- `npm run check`: PASS.
- JavaScript syntax checks: PASS.
- `npm run test:economy:postgres` without dedicated test URL: expected SKIP; no database connection attempted.
- Real PostgreSQL integration: NOT RUN.
- Browser/two-account staging test: NOT RUN.
- GitHub commit/push or Render deploy: NOT performed.

## Acceptance blockers

1. Execute the opt-in PostgreSQL suite against a separate disposable database and require all E1 and E2 cases to pass.
2. Deploy to the verified staging service, not production, and test with two disposable player accounts.
3. Verify First Bank login boundary, correct sender/recipient balance projection, transfer history, same-key retry, altered-key reuse rejection, insufficient funds, self-transfer, inactive destination, refresh/relogin and concurrency.
4. Record deployment SHA and test evidence before calling E2 accepted.

## Accounting boundaries

- E2 updates `netshift_bank_accounts.balance_cents` only inside the transfer helper's transaction.
- All monetary values are integer cents; browser-supplied balances/postings are never accepted.
- E1 website revenue summaries continue to derive from merchant-attributed ledger postings; transfers between players do not count as website sales.
- All other economy mutations remain deferred until their own server-authoritative chunks are implemented.
