# NETSHIFT Core v2 preview changelog

## Added
- Authoritative player profile schema and stable simulated workstation IP assignment.
- Isolated First Bank player account records with bcrypt-hashed in-game bank passwords.
- Server-backed SafetyShield setting and one-hour cooldown API, plus Windows-style confirmation UI in My Computer.
- Player file/folder/text CRUD API with ownership checks and soft deletion.
- Shared-host stock records and atomic one-winner download claim endpoint preserving software family and level.
- Inventory refresh ticker foundation and credential lockout field.
- Admin roles, audit schema, bans, user listing and moderation endpoints; operator-only grant CLI.


## Stage 1 follow-up — bounded host loot regeneration (prepared locally, not yet deployed)
- Added persisted host target classification (`website` versus `npc_workstation`); the seeded Forgetful Hacker host is an NPC workstation and WHOIS targets are websites.
- Replaced the unconditional Warez-L1 append ticker with a row-locked, PostgreSQL-timestamp-based loot refresh using a tested server-owned weighted loot table.
- Enforced stock limits of 3 for websites and 5 for NPC workstations; overfull legacy inventories are compacted at the next due regeneration, preserving fixed content and newer generated loot.
- A full inventory rotates its oldest generated item for a fresh item ID instead of growing forever. Software-level weights increase with firewall level; L1 remains the most common individual level and L5 remains rare.
- Added a shared stock-removal helper used by atomic claims and intended for future server-side NPC/security-sweep removal paths. Such system actions must lock/update canonical host stock and increment its version; no not-yet-implemented NPC/sweep behaviour is claimed as live.
- Added `scripts/check-stage1-host-loot-regeneration.js` to the automated suite. Local `npm run check` passes; PostgreSQL, Render concurrency and live staging regeneration tests remain required before acceptance.

## Explicitly not complete
- Full PvP resolution and post-hack immunity.
- Full UI migration to canonical server inventory/files/bank state.
- Complete NPC attack scheduler, exact loot snapshot regeneration and router logs.
- Administrator MFA enrollment/enforcement and production security sign-off.
- End-to-end PostgreSQL/staging testing.

## Staging hardening follow-up
- Allow a player's first SafetyShield change immediately; start the one-hour lock only after that change and persist the state across redeploys.
- Tighten `.gitignore` to cover `.env.*` without ignoring `.env.example`.
- Add a staging deployment guide and API-focused v2 preview acceptance checklist.

## Staging follow-up — First Bank UI integration
- Connected First Bank first-visit setup and subsequent customer login to server endpoints; bank passwords remain bcrypt-hashed server-side.
- Added server-verified bank account session state and logout.
- My Computer now displays account number/balance from `/api/core/profile` rather than the shared legacy `100001` demo account.
- Removed local-demo transfers from the displayed bank dashboard until an atomic server-side transfer/ledger endpoint is implemented.
- Expanded the staging bank checklist.

## Staging implementation slice — identity presentation and release sequencing
- Added `lib/game-identities.js` so virtual IP and bank account generation are explicit, reusable, testable helpers rather than logic embedded in the server routes.
- New simulated workstation IPs use mixed 2-/3-digit octets within the private `172.16.0.0/12` range, never depend on real client IPs, and rely on the database uniqueness constraint plus retry logic.
- Existing predictable `10.x.x.x` workstation IPs are migrated once when the player's profile is next loaded.
- New player bank account numbers are random eight-digit strings. Recognisable legacy values (including the earlier deterministic 12-digit values or a persisted six-digit demo value) are upgraded once; established eight-digit values are preserved.
- Load the server-issued profile before rendering the post-login page so the sidebar/legacy UI uses the player's server-assigned virtual IP instead of a constant placeholder.
- SafetyShield OFF now renders the heading/status in red with a foreground white cross over a red shield; ON remains green.
- Added `scripts/check-game-identities.js` and wired it into `npm run check`.
- Added `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` and `NETSHIFT_V2_IMPLEMENTATION_PLAN.md` as the working audit and dependency-ordered release plan.


## Backlog additions — 2026-10-13
- Added Router Admin IP-change purchase to the roadmap: configurable hefty fee, server-issued unique virtual IP, persisted change record, and stable identity after refresh.
- Added tracking-virus interaction: active tracking malware can observe/follow the victim's new IP after a change until the virus is removed; the change is logged and the tracking relationship is server-authoritative.
- Recorded authentication-test discrepancy: authenticated `/api/core/profile` returned 200, while the reported Incognito request returned 404. Current source `requireAuth` specifies 401 for unauthenticated sessions, so this needs diagnosis rather than being marked expected.


## Next roadmap slice — Force Connect, canonical files and account recovery groundwork

- Added a password-verified Force Connect path for unreachable incumbent sessions, including an explicit Windows-style confirmation and a fresh server-side reachability check before takeover.
- Added optional account email/verification columns and hashed, expiring, single-use password-reset token schema groundwork. Email sending, mailbox UI, and reset workflows remain future work.
- Extended canonical file API with server-backed Recycle Bin, restore, permanent deletion, rename, and parent-path moves. Added an active-only unique filename index so recycled filenames can be reused.
- Replaced native browser prompts for desktop text-file creation with server-backed `Untitled.txt` naming and an in-game Notepad with editable filename/content. Canonical Core file records are hydrated after login and omitted from the old client save blob.
- My Computer now displays `NONE` for the bank number and hides balance until First Bank setup is complete.
- Expanded the roadmap with session recovery, future bank-account lifecycle semantics, email domains/identities, 1,000-message caps, Spammer/Commander/Jammer mechanics, and deceptive Karmic Email attachment metadata.
- Local `npm run check` passes. Full state migration, email feature, and live staging/browser verification remain outstanding.

## Stage 1 — save-reset contract and migration fixtures
- Documented the project owner's decision to discard legacy schema-v1 save contents rather than migrate browser-only progress.
- Explicitly protected account identity and canonical server-side profile, bank, files and world records from that reset.
- Added 12 synthetic scenarios covering legacy save discard, bogus balance/purchase claims, canonical-record preservation, stale client writes, idempotent reset and atomic host-download conflict handling.
- Added a contract-fixture validator to `npm run check`. It validates contract/fixture consistency only; database migration and runtime behaviour remain unimplemented and unverified.


## Stage 1 — one-time legacy-save cutover (local, not deployed)
- Added `netshift_migration_receipts` and `lib/legacy-save-cutover.js`. On startup, the server obtains a transaction-scoped PostgreSQL advisory lock, checks a named receipt, deletes only the old `netshift_saves` rows, writes the receipt in the same transaction, and completes before opening the HTTP listener.
- Added guards so schema-v1 save documents are not returned by the save-read endpoint and schema-v1 POSTs receive `LEGACY_SAVE_RETIRED`, even if they claim revision zero.
- Added isolated tests for first run, canonical-record preservation, retry safety, rollback when receipt insertion fails, concurrent startup runs, and stale-schema recognition. Full `npm run check` passes locally.
- The test adapter is in-memory and does not validate PostgreSQL locking/transaction semantics. Schema-v2 preferences-only save writing and matching client protocol are still outstanding in Chunk 4. This intermediate build is not ready for deployment.


## Stage 1 — schema-v2 server save boundary (Chunk 4, local only)
- Added `lib/save-protocol.js` with a strict schema-v2 allowlist; `preferences.lastAddress` is the only accepted preference for now. Unknown request keys, protected gameplay state, invalid addresses and invalid revisions are rejected.
- Updated `GET /api/save` to return only validated preferences and to retain the real row revision when retiring invalid stored documents.
- Replaced the temporary save-disabled route with transactional create/update, active account-ownership locking and compare-and-set revision checks. Responses include `currentRevision` to support stale-client recovery.
- Added `scripts/check-stage1-save-protocol.js` to the standard check suite and expanded save-cutover wiring assertions.
- `npm run check` passes locally. Tests are unit/static only; no PostgreSQL or browser integration was performed. The frontend still sends schema-v1, so this intermediate source is not deployable as a working game build.


## Stage 1 — frontend preferences-only save cutover (Chunk 5, local only)
- Updated `netshiftSnapshot()` to emit schema-v2 `{ schemaVersion, preferences }` data only; `preferences.lastAddress` is currently the sole saved preference. The client no longer submits a full browser-state snapshot or restores saved gameplay state.
- Updated save, login restore, conflict reload and page-hide paths to use schema-v2 payloads and current server revisions. Conflict resolution restores preferences only and no longer resets/merges gameplay state.
- Added a preferences-readiness guard so manual, autosave and page-hide requests cannot race the initial revision read or write after the initial preferences read fails.
- Updated account toolbar copy to say “Save preferences” and added `scripts/check-stage1-client-save-protocol.js` to `npm run check`; updated the existing Core files UI check for the stricter preference-only snapshot.
- `npm run check` passes locally. No PostgreSQL, browser/two-account integration, GitHub operation or deployment was performed. Stage 1 remains incomplete; Chunk 6 implements the initial profile/canonical-inventory hydration gate, while inventory reconciliation and atomic host-download correction remain outstanding.


## Stage 1 — fail-closed profile and inventory hydration gate (Chunk 6, local only)
- Kept the account overlay blocking after authentication until the required Core profile, active file list and Recycle Bin list return valid response shapes.
- Added required-mode validation for profile fields and inventory rows. Empty arrays are accepted only when the server explicitly returns valid arrays; missing/malformed payloads and duplicate IDs fail the required load.
- Required profile, file and Recycle Bin requests use a 15-second timeout. Failed hydration presents Retry and Sign out controls; it does not start the autosave interval or connect the shared-world socket.
- Wrapped legacy gameplay-mutating timer callbacks so they pause while an authenticated account is not hydrated. Added a keyboard capture gate while loading.
- Added account/attempt identity fences so delayed responses from a prior or revoked session cannot overwrite the current account's profile or inventory mirror. Failed optional inventory refreshes retain the last confirmed mirror rather than returning a synthetic empty list.
- Added `scripts/check-stage1-hydration-gate.js` to `npm run check`; it covers profile/list validation, required-load ordering, retry/timeout wiring, stale-session fencing and gameplay timer pause behaviour.
- Validation: `node scripts/check-client.js`, the new hydration checks, and full `npm run check` pass locally. This is static/helper validation only; no browser, two-account, PostgreSQL, GitHub or deployment action was performed. Stage 1 remains incomplete; Chunk 7 is canonical inventory and software-view reconciliation.


## Stage 1 Chunk 7 — canonical inventory view reconciliation (local, 2026-10-13)

- Split hydrated canonical inventory into separate typed file, software and folder collections. Canonical file rows retain server IDs and derive locations from `parent_path`; canonical records no longer write to the ambiguous legacy filename-keyed folder map.
- Updated final Desktop/Explorer rendering for canonical files, installed software, Downloads, Archive, nested folders and Recycle Bin. Recycle Bin retains item type, stored filename and server ID; unknown software families remain visible without a guessed catalogue mapping. Authenticated hydration discards the legacy fictional `bank-info.txt` demo copy but continues to display a canonical server-owned item with the same name.
- Added the owner-scoped transactional software location API with software-family/level precedence. Restore now preserves level precedence, and generic recycle/permanent-delete operations refuse folders until safe subtree handling exists. Added normalized parent path validation.
- Added `scripts/check-stage1-canonical-inventory.js` to `npm run check`. Full local automated checks pass. No live browser, PostgreSQL, staging, GitHub or deployment validation was performed. Host-download atomicity remains Chunk 8; remaining legacy mutation paths remain Chunk 9.


## Stage 1 Chunk 8 — atomic shared-host downloads (local, 2026-10-13)

- Added `lib/host-download-claim.js` to atomically remove trusted host stock, write the loot-claim record and create the canonical player `/downloads` row. The canonical file insert no longer uses a conflict-ignore clause; a filename conflict or write failure rolls the entire transaction back.
- Added active account-session ownership and current host-control checks, a safe owner-only inventory read route, strict stock metadata validation, rejection of duplicate/reintroduced item IDs, and a rate-limited download mutation endpoint.
- Connected the shared-host UI to the inventory/download routes and reloads the canonical player files after a successful claim.
- Added `scripts/check-stage1-host-download-claim.js` to `npm run check`; the full local check suite passes. Mock SQL-adapter coverage is not proof of PostgreSQL transaction semantics. Live PostgreSQL and two-account browser testing remain outstanding. Remaining legacy client download writers are Chunk 9.


## Stage 1 — Chunk 9 legacy inventory authority fence (local only)
- Authenticated inventory hydration discards unmatched browser-only file, software, folder and Recycle Bin rows rather than treating local arrays as a second source of ownership. Canonical record IDs and server paths remain the basis of authenticated views.
- Fenced legacy local software install/run, website downloads, software downloads/purchases, local-file opening, drag/drop, context actions and Recycle Bin mutation paths for signed-in accounts. Canonical operations continue through the Core file/host-claim APIs; the offline prototype keeps its legacy paths.
- Added `scripts/check-stage1-legacy-inventory-fence.js` to the automated local check suite. Runtime PostgreSQL/browser validation has not been performed; banking, economy, hardware upgrades, malware and hacking outcomes remain separate outstanding state-authority work.

## Stage 1 Chunk 10 — regression/acceptance gate (prepared locally, not deployed)
- Added `scripts/check-stage1-acceptance.js` to the standard deterministic suite to verify test coverage/wiring for legacy-save safety, authenticated hydration, canonical inventory/legacy fencing, atomic claims/loot rules, cross-account evidence and release sign-off.
- Added opt-in `scripts/test-stage1-postgres.js` for real PostgreSQL host-claim commit, filename-conflict rollback, simultaneous single-winner claims, revoked/non-controller access and consumed-ID replay. It requires a dedicated `NETSHIFT_STAGE1_TEST_DATABASE_URL`, explicit disposable-database acknowledgement, refuses Render hosts, and creates/drops only a uniquely named isolated schema.
- Expanded the staging checklist and ownership audit with T1–T6 evidence mapping and explicit PASS/FAIL/BLOCKED rules. PostgreSQL and browser/staging checks remain pending until actually executed; this chunk does not sign off Stage 1.


## Economy implementation — E1 append-only ledger foundation (local candidate)
- Added an immutable double-entry money journal using integer cents, idempotency keys, request fingerprints, and deferred PostgreSQL constraints that reject any transaction with fewer than two postings or a non-zero total.
- Added immutable asset-provenance events linked to money transactions, plus database triggers that reject direct updates/deletes instead of allowing history to be silently rewritten. Historical actor/owner/account IDs are snapshots, so later user/account deletion does not cascade through the ledgers.
- Registered the existing `hack3rw4re.net` and `computerstore.net` storefronts as separate website merchants with separate treasury system accounts. The `netshift_website_income_summary` view derives gross receipts and net treasury balance from postings, so future website sales can be attributed per site. No income is invented before a server-authoritative sale occurs.
- Added fast deterministic E1 checks to `npm run check` and an opt-in disposable-database integration command `npm run test:economy:postgres`. PostgreSQL testing remains pending until a dedicated test database is configured. E1 deliberately adds no purchase/transfer endpoints and does not claim the economy is live.


## Economy E2 — First Bank player transfers (local candidate, 2026-10-14)
- Added a server-authoritative transfer service. Source and recipient player bank rows are locked in ascending account-ID order; the service records opening-balance baselines where required, writes one immutable `player_transfer` transaction with balanced integer-cent postings, debits the source and credits the recipient atomically.
- Added authenticated `POST /api/core/bank/transfers` and `GET /api/core/bank/transfers` endpoints. Transfers require current NETSHIFT session ownership and a separate First Bank authenticated session. Recipient accounts must be active player accounts that completed First Bank setup; self-transfers and insufficient funds are rejected.
- Added decimal-to-cents validation (no exponent or fractional-cent amounts), bounded references, sender-scoped idempotency keys, safe retry responses, and transfer history showing only each account's own transfer rows and counterparty account numbers.
- Connected the server-backed First Bank UI to transfer sending and recent activity; the UI retains the same idempotency key for unchanged requests after connection failures.
- Extended deterministic checks and the opt-in isolated PostgreSQL integration suite for atomic balance/ledger updates, retries, insufficient funds, self-transfer, unactivated recipients and concurrent overspend. `npm run check` passes locally. PostgreSQL tests skip safely without `NETSHIFT_ECONOMY_TEST_DATABASE_URL`; no live DB, GitHub or Render operation was performed.
