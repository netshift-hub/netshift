# NETSHIFT Stage 1 — Chunk 5 Checkpoint: Frontend Save Protocol Cutover

**Status:** Implemented in an isolated local working copy. `npm run check` passes. Awaiting owner review before Chunk 6. **Not a deployable release:** profile and canonical-inventory hydration gating, inventory reconciliation and database/browser integration remain outstanding.

## Source baseline

- Repository reference in previous checkpoints: `netshift-hub/netshift`
- Branch reference in previous checkpoints: `staging`
- Recorded baseline commit: `06c28e60f348e1b2b1891d00db597180afd4eae0`
- Working copy: `/mnt/data/netshift-stage1-work`
- This chunk was based on the Chunk 4 save-protocol bundle and checkpoint, not the mismatched general staging bundle.
- No `.git` directory or connected GitHub repository was available in this runtime. No GitHub operations, database operations or deployments were performed.

## Scope implemented

Chunk 5 changes the frontend save/load paths only. It does not implement general profile or inventory hydration gating, canonical inventory reconciliation, economy or PvP mechanics.

- `netshiftSnapshot()` now emits `{ schemaVersion: 2, preferences: { lastAddress } }`. `baseRevision` is attached only as request metadata by the save path. The client no longer serialises the whole legacy game state, `client` metadata or `savedAt` into `/api/save`.
- `preferences.lastAddress` is normalised and checked against the same broad host/internal-address shapes accepted by the server. Invalid browser addresses fall back to `whois.com`; server validation remains authoritative.
- Removed `netshiftDeepMerge()` and changed `netshiftRestoreSave()` to accept only schema-v2 preferences with exact allowed keys. It restores the saved address without merging any saved gameplay state into `state`.
- On authentication, transient and legacy browser gameplay state is reset to current defaults before restoring the address preference. Saved browser-only balances, inventory, hack outcomes and other state are no longer restored from cloud saves.
- Updated save success/error messages, the toolbar button, handoff language and conflict UI to say preferences rather than game progress.
- Save, conflict, and page-hide flows use the server's `currentRevision` (falling back to `revision`) and send the new preferences-only payload. Conflict resolution reloads the saved preference only; it no longer resets/merges the broader game state.
- Added a preference-readiness guard. Manual, periodic and page-hide writes are blocked while the initial preferences/revision are loading and remain blocked if the initial read failed. This avoids racing a save against an unknown revision. This readiness flag is **not** the full gameplay/inventory hydration gate assigned to Chunk 6.
- Updated `scripts/check-core-files-ui.js` to assert that the client snapshot is preference-only.
- Added `scripts/check-stage1-client-save-protocol.js` and included it in `npm run check`. The test exercises the extracted client helpers and checks save, restore, revision, conflict and page-hide wiring.
- Updated the migration contract, state-ownership audit, implementation plan and changelog.

## Validation performed

- `node scripts/check-client.js`: PASS.
- `node scripts/check-stage1-client-save-protocol.js`: PASS.
- `node scripts/check-core-files-ui.js`: PASS.
- `npm run check`: PASS, including syntax checks, multiplayer markers, session/chat, shared-world, Core v2/UI, identity, migration fixture, server save-protocol, client save-protocol and save-cutover tests.
- `sha256sum` recorded for the relevant code, checks, plans and checkpoint in `NETSHIFT_STAGE1_CHUNK5_SHA256.txt`.

## Not performed / remaining work

- No real PostgreSQL integration test. The save protocol's locking, compare-and-set revisions and cutover SQL still need verification against a disposable staging database.
- No interactive browser test or two-account isolation test.
- Chunk 6 must make normal gameplay and autosaves wait for successful profile and canonical-inventory hydration; current file-load code can still suppress failures.
- Canonical file/software rendering and mutation reconciliation remain incomplete. The host-download transaction still needs a conflict-safe atomic delivery test/fix, and legacy browser-side inventory mutation paths remain to be reconciled.
- This bundle is a development checkpoint only; do not deploy it as a complete game build.

## Next chunk

**Stage 1 Chunk 6 — Profile and canonical-inventory hydration gate.** Independently establish explicit loading readiness/error/retry state; prevent normal gameplay and autosave timers from starting until the required profile and canonical inventory reads succeed; ensure failure is not treated as an empty inventory. Keep all canonical inventory reconciliation and host-download transaction work for later chunks. Review actual source before implementing and stop after Chunk 6 for owner review.

## Operational boundary

The owner handles GitHub operations, including commits, pushes, branches and deployments. No remote repository changes or database operations were performed in this chunk.
