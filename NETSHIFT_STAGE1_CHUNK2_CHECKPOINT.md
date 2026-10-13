# NETSHIFT Stage 1 — Chunk 2 checkpoint

**Status: Complete (contract and test-fixture preparation only).** Waiting for explicit user authorisation before Chunk 3.

## Source baseline
- Repository: `netshift-hub/netshift`
- Branch: `staging`
- Commit: `06c28e60f348e1b2b1891d00db597180afd4eae0`
- Source directory: `/mnt/data/netshift-staging-tested`
- Core application source (`server.js`, `public/index.html`) was not edited in this chunk.

## Product decision recorded
The owner explicitly approved discarding current legacy save contents at this early stage. The new contract permits a one-time, version-gated, transactional and idempotent reset/ignore of schema-v1 `netshift_saves.save_data` and legacy browser-only progression/inventory. It does not permit deleting accounts or canonical server-side profile, bank, files, world, host-stock/claim, or admin records. Legacy client purchase claims must not create ledger rows.

## Files added/updated
- Added `NETSHIFT_STAGE1_MIGRATION_CONTRACT.md`.
- Added `scripts/fixtures/stage1-save-reset-cases.json` with 12 synthetic scenarios.
- Added `scripts/check-stage1-migration-contract.js` to validate fixture coverage and contract consistency.
- Updated `package.json` so `npm run check` includes the new contract test.
- Updated `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` to record the accepted reset policy and correct the file-read ownership note (those routes use `requireAuth`, whose middleware checks active session ownership).
- Updated `NETSHIFT_V2_IMPLEMENTATION_PLAN.md` to document the approved reset exception and avoid a contradictory blanket no-reset statement.
- Updated `CHANGELOG_V2.md`.

## Validation
See `NETSHIFT_STAGE1_CHUNK2_TEST_LOG.txt`. `node --check server.js`, `node scripts/check-client.js`, `node scripts/check-stage1-migration-contract.js`, and full `npm run check` all passed. The fixture test says explicitly that runtime migration is not yet implemented.

## Not done
- No migration/reset database code has been implemented or executed.
- No application code was changed.
- No database, production or staging service was accessed.
- No GitHub writes/pushes or deployments occurred.
- No Chunk 3 work has begun.

## Next chunk
**Chunk 3 — Migration implementation.** Build the one-time reset receipt/transaction and server-side migration gate; reject stale schema-v1 save writes; cover rollback/retry/concurrency and ensure canonical server-side tables remain untouched. Run isolated transaction tests before any disposable staging integration. Stop after Chunk 3 and wait for user approval before Chunk 4.
