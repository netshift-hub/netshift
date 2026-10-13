# NETSHIFT Stage 1 — Chunk 7 Checkpoint: Canonical Inventory Views

**Status:** Implemented in the isolated local working copy. The full `npm run check` suite passes. Awaiting owner review before Chunk 8. **Not a deployable release:** no live browser, PostgreSQL, staging, or two-account validation was performed.

## Source baseline and operational boundary

- Repository/branch/commit recorded by earlier checkpoints: `netshift-hub/netshift`, `staging`, `06c28e60f348e1b2b1891d00db597180afd4eae0`.
- Current working copy: `/mnt/data/netshift-stage1-work`.
- The working copy is an isolated local snapshot. There is no `.git` directory or connected repository in this runtime, so the live remote branch was not independently verified.
- No GitHub write, commit, push, PostgreSQL connection, database migration/reset, staging deployment, or production operation occurred.

## Scope implemented

This chunk reconciles canonical `netshift_player_files` records with the Desktop, Downloads, Archive, custom-folder Explorer views, and Recycle Bin. It does not wire the host-download UI or remove every legacy browser-side inventory writer; those remain later Stage 1 chunks.

- Hydrated canonical records are kept in typed collections: file records in the text-file mirror, software in `NETSHIFT_CORE_SOFTWARE`, and folders in `NETSHIFT_CORE_FOLDERS`. Canonical rows retain their server-generated IDs and `parent_path`.
- Known software catalogue IDs are derived only from trusted server-provided family/level metadata. Unknown family/level rows are not guessed or discarded by the view layer; they remain visible by the canonical stored filename and record ID.
- Final Desktop/Explorer renderers use canonical IDs for actions and display canonical rows in Desktop, Downloads, Archive and nested custom folders. Canonical software is presented as runnable only in the Desktop/installed view; Downloads/Archive/custom-folder items request a server-authorised location change/install.
- Recycle Bin hydration preserves the canonical `item_type`, stored filename and record ID for files, software and folders. Restore routes use the canonical ID and the API's family/level precedence. Unsupported folder recycle/permanent-delete operations fail closed to avoid orphaning children until an atomic subtree operation exists.
- Added owner-scoped `PATCH /api/core/files/:id/location` for software movement/installation. It uses a transaction, a per-account/software-family advisory lock, record ownership/session checks and software-family/level precedence; destination path validation uses canonical slash-delimited paths.
- Canonical file locations are derived from each record's `parent_path`. Canonical hydration/upsert/Notepad-save paths no longer write into the legacy filename-keyed `state.localFileFolders` map, which cannot safely distinguish same-name files in different folders.
- Authenticated hydration discards the legacy fictional-credential `bank-info.txt` demo item and removes its hard-coded demo icon. A real canonical server-owned file with that filename remains visible and linked to its own record ID.
- Legacy-only inventory rows remain transitional while Chunk 9 reconciles the remaining old download, software, folder, context-menu and recycle writers.
- Added `scripts/check-stage1-canonical-inventory.js` to `npm run check`; it checks typed mappings, ID preservation, view wiring/rendering, unknown catalogue families, shadowed legacy duplicates, owner-scoped software location/restore rules, folder-deletion restrictions and path validation.
- Updated the implementation plan, migration contract, ownership audit, staging test checklist, status README and changelog.

## Validation performed

- `node --check server.js`: PASS (also included in `npm run check`).
- `node scripts/check-client.js`: PASS (also included in `npm run check`).
- `node scripts/check-stage1-canonical-inventory.js`: PASS.
- `npm run check`: PASS, including save cutover/protocol, hydration-gate, Core UI, multiplayer/session/world, and canonical-inventory checks.
- `unzip -t /mnt/data/NETSHIFT_Stage1_Chunk7_CanonicalInventory_Bundle.zip`: PASS; the final archive is re-created and rechecked after this checkpoint is updated.
- SHA-256 hashes of tracked source/docs/checkpoint/test log are recorded in `NETSHIFT_STAGE1_CHUNK7_SHA256.txt`.

## Not performed / limitations

- No interactive browser or two-account test. The static/helper suite does not prove that every Explorer click, drag/drop, login/session transition or rendering path behaves correctly in a live browser.
- No PostgreSQL integration. The new software-location and restore transactions, advisory-lock behaviour, unique-constraint conflict handling and migrations need runtime validation against an intended disposable staging database.
- The canonical host-download endpoint remains disconnected from the client; its claim/file-insert conflict handling must be made loss-safe in Chunk 8.
- Legacy software/download/reward/context-menu and recycle actions still exist for non-canonical items. Chunk 9 must route/retire these paths so browser state cannot become a competing authority.
- Folder navigation/display is supported, but moving, renaming or deleting folders remains intentionally disabled until descendant path changes can be applied atomically.
- Unknown software may be visible even when the local application catalogue does not provide an executable handler; the UI does not fabricate a mapping.
- No GitHub, staging or production operation occurred.

## Next chunk — Stage 1 Chunk 8

Make host-stock claim, claim ledger and canonical player-file/software delivery a single all-or-nothing transaction. Resolve filename-conflict rollback, duplicate item IDs, concurrent claims and trusted host metadata. Wire the corresponding client download flows to the canonical endpoint only after those server semantics are safe. Stop for owner review before Chunk 9.

## Deployment status

**Do not deploy this checkpoint as a complete game build.** It is an isolated development snapshot with local static/helper test evidence only. The project owner controls GitHub operations, staging deployment and database selection.
