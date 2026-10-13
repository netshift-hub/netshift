# NETSHIFT Stage 1 — Chunk 6 Checkpoint: Fail-Closed Profile and Inventory Hydration

**Status:** Implemented in the isolated local working copy. `npm run check` passes. Awaiting owner review before Chunk 7. **Not a deployable release:** browser/database integration, canonical inventory reconciliation and remaining legacy mutation paths are outstanding.

## Source baseline and operational boundary

- Repository reference from prior checkpoints: `netshift-hub/netshift`
- Branch reference from prior checkpoints: `staging`
- Baseline commit recorded by prior checkpoints: `06c28e60f348e1b2b1891d00db597180afd4eae0`
- Current isolated working copy: `/mnt/data/netshift-stage1-work`
- This chunk continues the Chunk 5 local bundle. The runtime has no `.git` directory or connected repository, so live remote currency could not be re-verified.
- No GitHub operations, PostgreSQL access, staging/production deployment or database reset occurred.

## Scope implemented

This chunk gates authenticated gameplay on successful reads of the authoritative player profile and canonical file inventory, including the Recycle Bin. It does not implement canonical inventory reconciliation or the host-download transaction.

- Added `NETSHIFT_PROFILE_READY`, `NETSHIFT_FILES_READY`, `NETSHIFT_HYDRATION_READY`, an in-flight hydration guard and an incrementing hydration/session attempt ID.
- Authentication no longer hides the login overlay or connects the shared-world socket immediately. It displays a blocking loading state and keeps the account toolbar/world panel unavailable until the required profile and inventory loads succeed.
- The required profile response is validated for an object shape, a non-empty IP string, boolean `safetyShield` and `bankSetup` values, and a bank object. A missing or malformed profile fails the required load.
- The active-file and Recycle Bin endpoints must each return a real `files` array. Every row must have a non-empty string ID/name, a string `parent_path`, and an allowed `item_type` (`file`, `folder` or `software`). Duplicate IDs within either list and the same ID appearing in both lists are rejected. An explicitly returned empty array remains a valid empty inventory.
- File rows are validated and mapped into temporary arrays before the browser mirrors are changed. If mapping/rendering fails, the previous mirror is restored. Optional refresh failures retain the last confirmed canonical mirror rather than presenting the latest failed read as an empty inventory.
- Required profile, active-file, Recycle Bin and initial preferences reads use a 15-second timeout. If the profile or inventory load fails, the blocking overlay stays in place, no autosave timer starts, and the user can retry or sign out.
- If the profile and inventory succeed but the *preferences-only* GET fails, normal gameplay is allowed to continue; preference saving remains paused because the initial save revision is unknown. Preferences are not treated as canonical gameplay inventory.
- The autosave interval is created only after required hydration succeeds, and only if the initial preferences/revision read succeeded. The shared-world socket connects only after hydration succeeds.
- Existing legacy gameplay interval registrations are still present at page initialisation, but gameplay-mutating callbacks are guarded and pause once a user is authenticated but not hydrated. The retro clock and non-gameplay UI maintenance can continue. A capture-phase keyboard guard blocks gameplay shortcuts outside the blocking authentication overlay during hydration.
- Profile and file requests record the account/session attempt they started under. A late result from a prior, revoked or switched session cannot mutate the current profile/file cache or restore an old user's mirror over a newer account.
- Added `scripts/check-stage1-hydration-gate.js` to `npm run check`. It exercises the pure response validators and verifies the required-load ordering, timeout/retry hooks, stale-response fencing, and timer gates.
- Updated the Stage 1 implementation plan, ownership audit, migration contract and changelog to record Chunk 6 and the next bounded work items.

## Validation performed

- `node --check server.js`: PASS.
- `node scripts/check-client.js`: PASS (client JavaScript syntax OK).
- `node scripts/check-stage1-hydration-gate.js`: PASS.
- `npm run check`: PASS, including the existing multiplayer/session/world/Core UI/identity/contract/save-protocol/save-cutover tests and the new hydration-gate tests.
- Final source/document hashes are in `NETSHIFT_STAGE1_CHUNK6_SHA256.txt`.
- Bundle archive integrity is recorded in the test log.

## Not performed / remaining limitations

- No browser-based login/retry test, visual overlay test or two-account isolation test.
- No PostgreSQL integration test, database migration, staging access or production access. Existing save-cutover tests use an in-memory SQL adapter; they do not prove PostgreSQL semantics.
- Static/helper checks do not prove the overlay behaves correctly in a real browser or that all legacy UI event paths are blocked under every browser condition.
- The general game still contains browser-side gameplay systems. This chunk pauses their timers during the loading transition; it does not make those mechanics server-authoritative.
- Canonical software rows are not yet comprehensively reconciled with `state.owned`, installed-software views, Downloads and Archive. Legacy inventory writers remain. Host download stock/claim/file creation still needs the separate conflict-safe atomicity chunk.
- No GitHub write, commit, push or deployment occurred.

## Next chunk — Stage 1 Chunk 7

Reconcile canonical `netshift_player_files` rows with Desktop, Downloads, Archive, Recycle Bin and installed-software views. Investigate software family/level rendering, the current split between Core file rows and legacy `state.owned`/`state.archiveSoftware`, folder/path mapping and Recycle Bin item-type preservation. Keep this separate from Chunk 8's atomic host-download correction and Chunk 9's remaining legacy-writer cutover. Run source-backed checks and stop for owner review before proceeding to Chunk 8.

## Deployment status

**Do not deploy this checkpoint as a complete game build.** It is an isolated development snapshot. The project owner handles GitHub operations, staging deployment and database selection.
