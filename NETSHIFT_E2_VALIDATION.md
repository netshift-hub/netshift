# NETSHIFT E2 validation record

**Candidate:** E1 + E2 cumulative source snapshot
**Prepared:** 2026-10-14

## Local validation

- `npm run check` — **PASS**. This includes the entire inherited Stage 1 suite, E1 ledger contract tests, and E2 deterministic service/API/UI checks.
- `node --check server.js`, `lib/bank-transfer.js`, `scripts/check-bank-transfer.js`, and `scripts/test-economy-ledger-postgres.js` — **PASS**.
- Browser JavaScript extraction/parsing is covered by `scripts/check-client.js` — **PASS**.
- `npm run test:economy:postgres` — **SKIP**, because `NETSHIFT_ECONOMY_TEST_DATABASE_URL` was not configured. The script confirms no database connection was attempted.
- Browser/two-account staging run — **NOT RUN**.
- GitHub commit/push and Render deployment — **NOT PERFORMED**.

## Database integration cases added

The opt-in PostgreSQL suite includes E1 schema/ledger constraints and E2 tests for transfer balance updates, balanced postings, sent/received history query scoping, exact retry, changed amount/destination/reference under a reused idempotency key, insufficient-funds rollback, self-transfer denial, unactivated recipient denial, and concurrent overspend with ledger/balance reconciliation.

These cases are implemented but have not been executed against a real PostgreSQL instance in this workspace. A skipped run is not a pass.

## Source baseline and merge caution

This complete candidate is built on the E1 ZIP snapshot. During the current turn, GitHub `dev` still returned pre-E1 source for `package.json`, `server.js`, and `public/index.html`. Therefore this ZIP contains E1 plus E2 cumulatively. Before merging into a local checkout, review the GitHub Desktop diff and preserve any changes newer than the E1 baseline. Do not replace `.git` or introduce real `.env` secrets.
