# E1 upload and review guide

This ZIP is a **complete repository snapshot based on the verified `dev` source snapshot used for E1**, with the E1 ledger foundation added. It is not just a patch file. It was created for manual review/merge with GitHub Desktop; it should not be uploaded to GitHub as a ZIP attachment instead of project files.

## Safe merge workflow

1. Fetch the latest changes in GitHub Desktop and verify the working branch is `dev` (or the agreed staging development branch), not `main`.
2. Create a backup branch or copy of your existing repository before replacing/merging files.
3. Extract the ZIP to a temporary directory.
4. Compare the extracted files against your repository. This bundle was based on `dev` with these baseline Git blob identifiers at preparation time:
   - `server.js`: `384181358277950792a5943adbfd8304f180f3ad`
   - `package.json`: `1b012b2caf40f7aab0d49de7b5ae0820485abdd2`
   - `public/index.html`: `48da9b833217e74485179a755f855a7dc19693e08`
5. Copy/merge the changed files into your repository while preserving `.git` and your local environment. Do not copy real `.env` files into the repository. `.env.example` is safe to keep.
6. Review the GitHub Desktop changes, especially `server.js`, `package.json`, and the new `lib/` and `scripts/` files. Verify no E2 purchase/transfer route or existing bank-balance mutation was accidentally included.
7. Run `npm run check`. Then commit and push the E1 chunk. Do not deploy until the database integration suite passes and the staging deployment/database are verified.

## New E1 files

- `lib/economy-ledger.js` — balanced integer-cent postings, opening-balance baseline helper, idempotency fingerprints and immutable asset-event helpers.
- `lib/economy-ledger-schema.js` — idempotent tables, deferred commit-time balance constraints, append-only triggers, merchant accounts and per-website income view.
- `scripts/check-economy-ledger.js` — deterministic tests included in `npm run check`.
- `scripts/test-economy-ledger-postgres.js` — real PostgreSQL integration tests isolated to a randomly named temporary schema.
- `NETSHIFT_ECONOMY_LEDGER_DESIGN.md` — accounting model and merchant income design.
- `NETSHIFT_E1_LEDGER_CHECKPOINT.md` — scope, evidence and remaining gate.

## Test commands

```bash
npm run check
npm run test:economy:postgres
```

The second command is expected to skip if no dedicated database is configured. A skipped test is not a pass.

For an intentionally created disposable database, set these environment variables in your terminal only:

```powershell
$env:NETSHIFT_ECONOMY_TEST_DATABASE_URL = "postgresql://USER:PASSWORD@localhost:5432/netshift_test"
$env:NETSHIFT_ECONOMY_TEST_DB_ACK = "I_CREATED_A_DISPOSABLE_DATABASE"
npm run test:economy:postgres
```

Use a separate disposable database, not the application `DATABASE_URL`, and never commit database credentials. For a remote disposable database, its database name must clearly indicate test/disposable/staging/scratch/CI and you must also explicitly set `NETSHIFT_ECONOMY_ALLOW_REMOTE_TEST_DB=YES_I_CREATED_A_DISPOSABLE_POSTGRES_DATABASE`. The script creates and drops only a random test schema.

## Important scope boundaries

E1 does not implement money transfers, paid purchases, hardware upgrades, website payouts, income rewards, NPC cashouts, or paid trades. It does not modify existing bank balances or open a migration baseline. It also does not yet make the legacy browser shops functional online. These are separate chunks and should call the ledger in the same database transaction as the actual balance/asset change.
