# NETSHIFT Stage 1 — Chunk 3 checkpoint

**Status: Complete (local implementation and isolated tests).** Awaiting explicit user authorisation before Chunk 4.

## Source baseline
- Repository: `netshift-hub/netshift`
- Branch: `staging`
- Baseline commit: `06c28e60f348e1b2b1891d00db597180afd4eae0`
- Working directory: `/mnt/data/netshift-staging-tested`
- No GitHub writes or deployment were performed.

## Changes implemented
- Added `lib/legacy-save-cutover.js` with the named migration `stage1-legacy-save-reset-v1`.
- Added `netshift_migration_receipts` schema creation to startup DDL.
- The startup sequence awaits the cutover after schema/host seeding and before starting the HTTP listener.
- The cutover takes a transaction-scoped PostgreSQL advisory lock, checks the receipt, deletes only `netshift_saves` rows, inserts a receipt in the same transaction, and commits. Existing receipts make later startup runs no-ops.
- If the transaction fails before commit, helper code rolls back and propagates the error, preventing the server from starting on a partial cutover.
- `GET /api/save` no longer returns legacy/unknown schema documents; it returns an empty save response for anything other than schema version 2.
- `POST /api/save` explicitly rejects schema-v1 payloads with HTTP 400 and code `LEGACY_SAVE_RETIRED`; base revision zero cannot bypass it.
- Added `scripts/check-stage1-save-cutover.js` to `npm run check`; updated `scripts/check-multiplayer-markers.js` to expect the fail-closed save-protocol marker only while saves are deliberately disabled, and to require `currentRevision` once the replacement protocol is enabled. In-memory adapter tests cover first run, canonical-record preservation, idempotent retry, receipt-insert failure/rollback, concurrent startup calls, and retired-schema detection plus server wiring.
- Updated migration contract, ownership audit, implementation plan and changelog to distinguish implemented behaviour from outstanding PostgreSQL/runtime validation.

## Validation performed
- `node --check server.js`: PASS.
- `node --check lib/legacy-save-cutover.js`: PASS.
- `node --check scripts/check-stage1-save-cutover.js`: PASS.
- `node --check scripts/check-multiplayer-markers.js`: PASS.
- `node scripts/check-stage1-migration-contract.js`: PASS (12 contract fixtures).
- `node scripts/check-stage1-save-cutover.js`: PASS (in-memory SQL adapter; scenarios listed above).
- `npm run check`: PASS (all pre-existing static checks plus contract and cutover checks).

See `NETSHIFT_STAGE1_CHUNK3_TEST_LOG.txt` for the recorded commands/results and `NETSHIFT_STAGE1_CHUNK3_SHA256.txt` for local final-file hashes.

## Important deployment warning
**This intermediate build is not ready to deploy.** The existing frontend still submits schema-v1 save payloads; the server now correctly rejects them. Chunk 4 must implement the schema-v2 preferences-only allowlist and matching client protocol, plus save/hydration gating, before this branch is deployable as a working game build. During cutover deployment, ensure old app instances are fully drained so an older process cannot recreate schema-v1 rows after the one-time receipt is written.

## Not performed / unresolved
- No real PostgreSQL or staging database was connected. The in-memory adapter tests the helper's control flow but does not prove PostgreSQL advisory-lock/transaction semantics.
- No staging or production reset was executed. When this code first starts against a database, it will delete rows in `netshift_saves` once, as explicitly approved; canonical tables are not part of that DELETE.
- The schema-v2 allowlisted writer/client protocol and hydration gating belong to Chunk 4.
- Host-download conflict rollback, canonical software reconciliation and legacy inventory UI mutations remain later Stage 1 work.

## Next step
Chunk 4 — Save boundary and migration cutover: implement schema-v2 preferences allowlist and frontend protocol; hold saves until profile/canonical inventory hydration succeeds; add tests for protected-field injection, legacy write rejection and hydration failure. Do not begin without explicit user approval.
