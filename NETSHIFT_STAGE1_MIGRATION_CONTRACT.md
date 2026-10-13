# NETSHIFT Stage 1 — Legacy Save Reset and Inventory Cutover Contract

**Status:** Implemented locally in `lib/legacy-save-cutover.js` and wired into startup. The one-time transaction has isolated in-memory behavioural tests; no real PostgreSQL database has been used, so database/staging execution remains unverified.

**Source baseline:** `netshift-hub/netshift` branch `staging`, commit `06c28e60f348e1b2b1891d00db597180afd4eae0`.

## 1. Approved product decision: legacy saves are disposable

The project owner has explicitly confirmed that current accounts' legacy game-save contents do not need to be preserved. The migration will therefore use a **clean save cutover**, not a field-by-field conversion of the legacy browser state. This permission applies to legacy save/gameplay state, not to deleting player accounts or unrelated server-authoritative records.

The cutover may discard schema-v1 and malformed/unknown legacy documents in `netshift_saves.save_data` and reset legacy browser-only gameplay state to the current game's defaults. Any schema-v2 documents already present are preserved. This is an intentional early-development reset, not an accidental side effect.

### Data deliberately discarded / reset

- Existing `netshift_saves.save_data` documents using schema version 1.
- Legacy browser-only inventory collections such as `state.owned`, `state.archiveSoftware`, `state.localFiles`, `state.userFoldersV2`, `state.localFileFolders`, legacy `state.recycleBin` entries, and local download queues.
- Legacy/demo balance, account, activity, log, upgrade, access, hack-result, malware/infection and NPC state held only inside the legacy save document.
- Fictional credentials or account-number text embedded in old demo files such as `bank-info.txt`.
- Any apparent shop purchase or upgrade represented only by browser state. It must not be converted into a transaction or treated as proof of ownership.

No attempt should be made to infer which of these client-originated fields are legitimate. Their loss is an explicit trade-off accepted by the project owner.

### Data that must remain intact

A reset of legacy save state must **not** cascade into unrelated PostgreSQL records or delete player accounts. Preserve, subject to normal application retention rules:

- `netshift_users` and their authentication hashes.
- Account/session ownership and login-handoff records, with ordinary expiry/cleanup behaviour unchanged.
- `netshift_player_world` identity/security/profile state.
- `netshift_bank_accounts` and their server-side credentials/balances; do not rebuild these from a legacy save.
- `netshift_player_files`, including already-canonical files, folders, software items and recycled records.
- `netshift_world_targets`, `netshift_world_player_target_progress`, `netshift_world_events`, `netshift_world_host_inventory`, and `netshift_world_loot_claims`.
- Existing admin-role/audit records and other dedicated server-side data not explicitly covered by a later migration.

If a later schema change requires touching one of these tables, it needs its own explicit migration and tests; the legacy-save reset is not authority to wipe it.

## 2. Canonical inventory contract

`netshift_player_files` is the server-side source of truth for file/folder/software rows. Current rows are identified by the server-generated UUID `id` and scoped to `user_id`. Relevant properties include `parent_path`, `name`, `item_type`, `mime_type`, `content`, `software_family`, `software_level`, `deleted_at` and `recycle_bin_at`.

- A client mirror is presentation/cache state only and must retain a server record ID so mutations target the canonical row.
- Legacy saved collections are not imported into this table after the clean reset. The frontend starts from default legacy state and hydrates from the authenticated canonical files APIs.
- Existing canonical rows are preserved by the cutover. It must not duplicate, rename, reassign, or delete those rows as a side effect of discarding `netshift_saves`.
- Software records already in `netshift_player_files` remain canonical inventory. Their corresponding UI/installed-software view must be fixed to display them; failure to render a row is a synchronization bug, not grounds to create a replacement row.
- Unknown or unresolvable legacy software is discarded with the legacy save. It must not create a guessed software-family row.
- Legacy purchases, transfers, cash-outs, rewards or upgrades must never create ledger entries. Transactional economy is Stage 2 and is out of scope here.

## 3. One-time reset and save protocol requirements

The implementation and remaining acceptance requirements are:

1. **One-time and atomic — implemented, PostgreSQL integration pending:** startup calls `applyLegacySaveCutover(pool)` before the HTTP listener starts. The helper uses a transaction-scoped PostgreSQL advisory lock, checks the named `stage1-legacy-save-reset-v1` receipt, deletes only non-v2/legacy-or-unknown rows in `netshift_saves`, then writes the receipt in the same transaction. Existing schema-v2 documents are preserved. A failure before commit must roll both back. Isolated tests cover first run, retry, rollback and concurrent runners; validate the SQL against a disposable PostgreSQL database before release.
2. **Version-gated — implemented locally, integration pending:** `GET /api/save` suppresses any stored document whose schema is not the current version 2. `POST /api/save` explicitly rejects schema-v1 documents with `LEGACY_SAVE_RETIRED`, regardless of `baseRevision`. The server enforces a schema-v2 preferences-only allowlist, and the frontend now submits/restores only that allowlist. PostgreSQL and browser integration are still required before deployment.
3. **Server-authoritative values remain dedicated:** a new save protocol must use an explicit allowlist for non-authoritative preferences only. Balances, bank credentials, inventory/software ownership, simulated IP, SafetyShield/cooldowns, host stock/claims, hack outcomes, NPC outcomes and security logs must not be writable through the generic save blob.
4. **Safe default on old data:** while a version-1 save is being retired, the login flow must start a clean default gameplay state. It must not reinterpret malformed, unknown-version or client-submitted values as canonical inventory.
5. **Hydration gating — implemented locally in Chunk 6, browser verification pending:** normal gameplay/save timers must not start until required profile and canonical inventory loads succeed. A failed load must show/retry an error and must not be interpreted as an empty inventory. Static/helper tests are not a substitute for browser validation.
6. **No implicit data wipe beyond scope:** no deletion from `netshift_users`, `netshift_bank_accounts`, `netshift_player_world` or `netshift_player_files` as part of the save reset. There must be an explicit audit of the SQL mutation set before release.
7. **Deployment protection:** run only against the intended disposable staging database during validation. Verify branch and database identity before deployment. Do not reset production or connect to production as part of these tests.

A database-wide save reset is allowed here only because the project owner expressly approved losing current legacy saves. It must not become the default response to future data bugs. Once players are properly playing on the intended server-authoritative architecture, preservation and tested forward migration become mandatory.

## 4. Host-download atomicity contract

`POST /api/core/hosts/:slug/download` must eventually claim stock and deliver the matching canonical player-file row as one indivisible transaction.

- If the claim succeeds, exactly one matching file/software row must be created for the owning player.
- If the player-file insertion conflicts or otherwise fails, stock, claim ledger and file insertion must all roll back. `ON CONFLICT DO NOTHING` without checking the inserted row is not acceptable for this transaction.
- Repeating a consumed item ID must not create duplicate ownership or consume additional stock.
- Two concurrent claims for the same item must yield exactly one winner.
- A row's software type/family/level must be based on trusted host-stock metadata, not client-submitted names, IDs or extensions.

This behaviour was implemented locally in Stage 1 Chunk 8 through `lib/host-download-claim.js` and the authenticated host inventory/download routes. The local mock SQL adapter covers success, filename-conflict rollback, unexpected file-write rollback, duplicate item IDs and a single winner under concurrent claims. Real PostgreSQL and browser/two-account validation remain outstanding.

## 5. Fixture and test boundaries

`scripts/fixtures/stage1-save-reset-cases.json` supplies synthetic, non-sensitive fixtures for the intended behaviours. `scripts/check-stage1-migration-contract.js` validates fixture coverage and contract invariants only. It does not connect to a database, perform the reset, prove migration idempotency, or replace integration tests.

Local isolated tests cover reset marker first-run, idempotent retry, synthetic receipt-insert failure/rollback, concurrent startup attempts, canonical-record preservation and stale schema-v1 recognition/server wiring. They use an in-memory SQL adapter and do not prove actual PostgreSQL locking or transaction semantics.

**Stage 1 Chunks 4–7 update (local only):** Chunk 4 adds the server's strict schema-v2 preferences-only allowlist (`preferences.lastAddress` is the sole current preference), sanitised reads, active account-ownership locking and optimistic revision checks. Chunk 5 moves the frontend save, restore, conflict and page-hide paths to schema v2 and removes full-state save merging. Chunk 6 adds required profile/inventory response validation, an authentication overlay that blocks normal play until these reads succeed, recoverable read timeouts, a retry path, gameplay-timer callback pauses and autosave creation only after hydration. Chunk 7 splits canonical rows into typed file/software/folder models; wires Desktop, Downloads, Archive, custom folders and Recycle Bin to canonical records; keeps record IDs through rendered mutations; adds server-authorised transactional software-location changes and restore precedence; and refuses unsupported folder deletion. The legacy filename-keyed location map remains transitional-only, and legacy download/mutation writers are not yet fully retired. Local static/helper checks pass; no PostgreSQL or interactive browser test has been performed. Do not deploy this as a complete game build.
Remaining contract tests: disposable PostgreSQL integration; interactive hydration failure/retry; two-account isolation; browser confirmation of filename-conflict rollback and concurrent host-claim races; and canonical inventory consistency after refresh/relogin. Chunk 8 mock-adapter tests do not prove actual PostgreSQL row-locking or transaction semantics.

## 6. Acceptance gate for this contract

- [x] The data-loss boundary is documented and the reset helper only deletes `netshift_saves` rows.
- [x] A receipt plus transaction-scoped lock makes the cutover idempotent by design.
- [x] The active server suppresses schema-v1 reads and rejects schema-v1 writes.
- [x] Isolated tests cover first run, retry, failure rollback, concurrent startup and preservation of canonical-record fixtures.
- [x] The server-side schema-v2 save allowlist rejects unknown/protected fields, sanitises stored documents and applies revision checks in a transaction (unit/static tests only).
- [ ] Execute migration and save-protocol SQL/transaction tests against disposable PostgreSQL; in-memory/static tests are not a substitute.
- [x] Migrate the frontend to submit/restore only schema-v2 preferences in Stage 1 Chunk 5 (local static/contract tests pass; browser integration remains unverified).
- [x] Add profile and canonical-inventory hydration gating in Stage 1 Chunk 6 (local static/helper checks pass; browser runtime unverified).
- [ ] Verify default login and retry behaviour in a browser; prove failed or malformed reads cannot unlock gameplay or start autosaving.
- [x] Add canonical file/software/folder view mapping, server-record ID rendering, Recycle Bin item types and transactional software location changes in Stage 1 Chunk 7 (local static/helper checks pass; browser/PostgreSQL validation remains outstanding).
- [ ] Verify canonical file/software rendering, account isolation, failed hydration and atomic host downloads in a browser and against disposable PostgreSQL. Chunk 8 implements the local transaction path and mock tests, but the runtime acceptance gate remains open.
