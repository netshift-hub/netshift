# NETSHIFT Stage 1 — Chunk 4 Checkpoint: Server-side Save Boundary

**Status:** Implemented in an isolated local working copy. Syntax/static/unit checks pass. Awaiting owner review before Chunk 5. **Not deployable:** the frontend still submits schema-v1 full-state payloads, which the server deliberately rejects.

## Source baseline

- Repository reference in prior checkpoints: `netshift-hub/netshift`
- Branch reference in prior checkpoints: `staging`
- Recorded baseline commit: `06c28e60f348e1b2b1891d00db597180afd4eae0`
- Actual working copy for this chunk: `/mnt/data/netshift-stage1-work`
- Copy was extracted from the saved `NETSHIFT_Stage1_Chunk3_Cutover_Bundle.zip` and matches the Chunk 3 hashes for `server.js` and `package.json` before edits.
- No `.git` directory or connected GitHub repository was available in this runtime. No GitHub operations, database operations or deployments were performed.
- The separately saved `NETSHIFT_Core_v2_Staging_Bundle.zip` is a different source version: its `server.js` and `package.json` hashes differ, it lacks the Chunk 3 save-cutover helper/tests, and its save endpoint still accepts schema-v1 payloads. It was not used as the base for this chunk.

## Work completed

- Added `lib/save-protocol.js`, using the existing shared save-schema version constant.
- The schema-v2 request contract permits only `schemaVersion`, `baseRevision` and `preferences`. The only currently allowlisted preference is `preferences.lastAddress`, validated and normalised as an in-game address.
- Rejects schema-v1 and unknown schema versions, unexpected top-level keys, unexpected preference keys, malformed addresses and invalid revisions. Client-supplied gameplay state, balances, inventory, hack outcomes and logs cannot be written through this endpoint.
- `GET /api/save` now returns only a validated canonical preferences document. Invalid/legacy stored documents are not returned raw; the real stored revision is retained so the client can replace an invalid document without a permanent revision-conflict loop.
- `POST /api/save` now performs transactional insert/update. It locks and rechecks the account-ownership row, inserts a first save only when `baseRevision` is zero and no row exists, and performs subsequent updates only when the submitted revision matches the current revision. Conflict responses contain `currentRevision`.
- Added `scripts/check-stage1-save-protocol.js` and wired it into `npm run check`.
- Updated save-cutover static assertions, migration contract status, ownership audit, implementation plan and changelog to reflect the new chunk split and its limitations.

## Validation performed

- `node --check server.js`: PASS.
- `node --check lib/save-protocol.js`: PASS.
- `node --check scripts/check-stage1-save-protocol.js`: PASS.
- `npm run check`: PASS, including client syntax, multiplayer markers, session/chat checks, world-compromise checks, Core v2/UI checks, game identity checks, migration fixtures, save-protocol tests and save-cutover tests.
- New unit/static tests cover valid preferences, schema/revision shape, protected-field injection, unknown preference fields, unsafe addresses, stored-save sanitisation, account-lock/writer wiring and compare-and-set revision markers.

## Not performed / outstanding

- No live PostgreSQL test: actual transaction, locking, conflict and SQL semantics remain unverified against a disposable database.
- No browser integration test or two-account isolation run.
- No frontend protocol changes in this chunk. `public/index.html` still creates a schema-v1 whole-state save, so `/api/save` rejects the current frontend's POSTs. Do not deploy this intermediate build as a working game.
- Hydration gating, canonical inventory view reconciliation, host-download atomicity repair and full legacy inventory-mutation elimination are not addressed by this chunk.

## Next chunk proposed

**Stage 1 Chunk 5 — Frontend save protocol cutover only.** Update snapshot, save, restore, reload/conflict and page-hide paths to submit/consume schema-v2 preferences only; remove all full-state merging through the cloud-save path; use the server revision correctly. Keep profile/inventory hydration gating for Chunk 6. Do not implement economy, PvP or other future-stage features in this chunk.

## Resume instructions

1. Begin from the files in this checkpoint's bundle, not from the mismatched general staging bundle.
2. Review this checkpoint and the diff before starting Chunk 5.
3. Keep all changes in an isolated working copy; the project owner handles GitHub operations.
4. After Chunk 5, run checks, update the checkpoint and stop for owner review before Chunk 6.
