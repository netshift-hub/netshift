# NETSHIFT Stage 1 — Chunk 8 checkpoint

**Status:** Local implementation complete; stopping for owner review before Chunk 9.
**Recorded:** 2026-10-13.
**Working copy:** `/mnt/data/netshift-stage1-work` (isolated local source snapshot; no Git worktree or live remote verification available in this runtime).
**Scope:** Atomic shared-host stock claim and canonical inventory delivery. No economy, PvP feature expansion, email/NPC feature implementation or deployment work was included.

## Objective

A host-stock claim, claim-ledger entry and canonical player-file delivery must succeed or fail together. A filename conflict must not consume stock. A player must currently control the target host before viewing or claiming its stock. The client must not supply the item's canonical filename, file type, content, software family or level.

## Changes implemented locally

- Added `lib/host-download-claim.js` to implement the transactional claim service.
- The service begins a transaction and checks that `netshift_account_ownership.session_id` still belongs to the current session while holding the account ownership row lock. It locks the shared target and then the host inventory, following the documented ownership → target → inventory lock order.
- Claims fail with HTTP 403 unless the account currently controls the target through `compromised_by_user_id`. Missing hosts/inventory and revoked sessions fail explicitly.
- Host stock is validated as trusted server-owned metadata. Malformed entries, duplicate IDs, invalid names/types or incomplete software family/level records fail closed. Item IDs are validated; previously claimed IDs are rejected even if erroneously reintroduced into stock.
- The transaction updates stock/inventory version and regeneration timestamps, writes `netshift_world_loot_claims`, and inserts the canonical player-file row under `/downloads`. The file insert no longer uses `ON CONFLICT DO NOTHING`; a unique active-name conflict triggers rollback and a recoverable HTTP 409 `DOWNLOAD_NAME_CONFLICT` response. Unexpected errors also roll back.
- Added `GET /api/core/hosts/:slug/inventory`, which returns safe inventory metadata only to the current host controller, and rate-limited `POST /api/core/hosts/:slug/download`, where the client may submit only `itemId`.
- Connected the shared-host UI to the new inventory and download endpoints. On a successful claim the UI refreshes the player's canonical file records instead of creating a local item.
- Added `scripts/check-stage1-host-download-claim.js` to `npm run check`. The check uses a deterministic mock SQL adapter and static source assertions.
- Updated the implementation plan, state-ownership audit, migration contract, staging checklist, README status and changelog to describe the actual local implementation and its unverified runtime gates.

## Validation performed

- `node --check server.js`: PASS (also included in `npm run check`).
- `node --check lib/host-download-claim.js`: PASS.
- `node --check scripts/check-stage1-host-download-claim.js`: PASS.
- `node scripts/check-stage1-host-download-claim.js`: PASS.
- `npm run check`: PASS (full available local suite).
- `unzip -t` on the final bundle: to be recorded after final packaging.

The focused mock-adapter cases cover successful canonical delivery, filename-conflict rollback, unexpected file-write rollback, duplicate/reintroduced item IDs, current host ownership, trusted metadata, request wiring, and concurrent same-item claims with exactly one winner. The tests verify the service's transaction flow in the mock adapter; they do **not** prove PostgreSQL lock/isolation/constraint behaviour.

## Not performed / remaining blockers

- No real PostgreSQL integration or disposable staging database operation was performed.
- No interactive browser or two-account staging test was performed.
- No regeneration-timer test was performed against a running server/database.
- No GitHub operations, commits, pushes or deployments were performed. The working copy is local and the live remote branch was not verified.
- Chunk 9 remains necessary: reconcile or retire legacy browser-side download, software, folder, recycle and other inventory writers that can create competing local state.
- Stage 1 Chunk 10 final acceptance remains open. Stage 1 is not complete and this bundle is not launch-ready.

## Chunk 9 entry criteria

Proceed only after owner review. Start from this full bundle/checkpoint, inspect the legacy inventory writers still referenced in `NETSHIFT_STATE_OWNERSHIP_AUDIT.md`, and migrate or disable one coherent family of writers at a time. Do not add economy transactions or later-stage PvP/email/NPC features in Chunk 9.
