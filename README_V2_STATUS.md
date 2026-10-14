# NETSHIFT Multiplayer Core v2 — implementation preview

This package is an incremental development build based on v1.3. It is **not yet a production-ready multiplayer release**. It includes the next server-authoritative foundations and a visible SafetyShield control, while full gameplay integration and real database/runtime testing remain outstanding.

## Implemented in this preview

- Additive PostgreSQL schema for persistent player world profiles, stable simulated workstation IPs, player bank records, player files, shared-host inventory/loot claims, admin roles/audit events and account bans.
- Player world profile creation on registration/login. First Bank player records are distinct from NPC account-file loot; the opening balance is $500. First Bank setup/login use server APIs and bcrypt password hashes. E1 provides append-only double-entry money postings, asset provenance and per-website treasury reporting; E2 adds a server-authoritative player-transfer API and transfer history in the local candidate. E2's PostgreSQL and browser/two-account tests are still pending, and other economy actions are not yet migrated.
- SafetyShield UI in My Computer, ON by default, with Windows-style confirmation dialog and server-side one-hour change cooldown. PvE is not disabled by SafetyShield.
- Authenticated file CRUD API for creating folders/text files, reading current player files, editing text, and soft-deleting files.
- Shared-host download claims now use the Stage 1 Chunk 8 transaction helper locally: stock, claim ledger and canonical player-file delivery roll back together on failure. Full PostgreSQL and browser/two-account validation remain outstanding; do not treat the flow as staging-verified.
- Initial shared-host inventory rows and database-timestamp-based regeneration ticker foundation. Credential-looking loot sets a three-day host credential lockout.
- Admin APIs for user listing, kick, ban, unban and protected audit-log reading. Admin grants are made only by the operator-run CLI script, not by a public route.
- Existing session ownership and previous v1.3 shared-world mechanics are retained.

## Admin role provisioning

1. Create and test the account normally.
2. Run the grant script from a trusted operator environment with production database access:

   ```sh
   NETSHIFT_ADMIN_GRANT_CONFIRM=GRANT_ADMIN_TO:username npm run admin:grant -- username
   ```

3. Do not expose the production database URL or run this from a public client. The confirmation value must match the exact username.

**Important:** the role schema records that MFA is required, but per-admin MFA enrollment and enforcement are not implemented in this preview. Do not grant admin roles to ordinary users or treat these admin endpoints as ready for public production until MFA is implemented and verified.

## Remaining work before calling this Multiplayer Core v2 complete

- Full PvP attack endpoint: target SafetyShield checks, Waterwall/Firewall inventory validation, 30-minute post-success immunity, allowed loot/deletion rules, attack audit events and concurrent attack tests.
- Canonical player-to-player software gifting/trading and complete removal of split software/inventory authority from existing gameplay UI. Stage 1 Chunk 7 improves canonical views, but legacy `state.owned`/download/reward handlers still exist.
- Integrate existing NefariousUploader and all legacy download/upload flows with server-owned file/software IDs; the legacy browser UI still has local-state flows that are not yet fully migrated.
- Correct and verify the legacy Warez L1–L5 upload bug, database file contents, transactional bank transfers/ledger, connection-log deletion, Recycle Bin delete-all, draggable desktop positions, pinned WHOIS listings, and full right-click Explorer operations against the persistent API.
- NPC attacks on a server-side 15–60 minute schedule, real simulated NPC addresses, router admin intrusion logs and probability tuning. The ticker is only an initial regeneration foundation and still needs item-snapshot-based exact inventory restoration and money-loot transaction rules.
- Regeneration based on the last successful intrusion, with full three-day credential lockout semantics, restart-safe scheduling, and tests that prove no duplicate stock or currency.
- Enforce Firewall L1–L6 as actual defensive state and Waterwall L1–L6 as offensive state in every relevant legacy hack flow.
- Enforce MFA for administrators, socket disconnection on kick/ban, ban enforcement on all existing authenticated routes, and audit-log tamper-resistance controls.
- Add transactional player bank transfers/ledger and defined player-to-player PvP theft limits. The generic save API is now restricted locally to schema-v2 preferences; the remaining gameplay/economy fields must use dedicated authoritative APIs.
- End-to-end test against a disposable PostgreSQL database, then two separate browser profiles against a deployed staging instance. This preview has only static/syntax checks; it has not been tested against live PostgreSQL, Render or Neon.

## Staging preview update (2026-10-13)

- Corrected SafetyShield cooldown initialization: the default ON setting may be changed once immediately; the one-hour cooldown begins after the first actual change. The change state is persisted in `shield_has_been_changed` so it survives restarts.
- Updated `.gitignore` to exclude `.env.*` while explicitly preserving `.env.example`.
- Added `NETSHIFT_CORE_V2_STAGING_DEPLOYMENT.md` and `NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md` for controlled staging rollout and API validation.

## Verification

Run `npm run check`. It checks server syntax, embedded client JavaScript syntax, existing multiplayer tests and static Core v2 feature markers. It does not replace integration tests against PostgreSQL.

## Existing deployment environment

The package retains the existing `DATABASE_URL` and `SESSION_SECRET` configuration. Database schema changes are additive and run at application startup. Back up the database before staging this build. Do not deploy to production until the outstanding security and gameplay items above have been completed and tested.

## Latest local implementation slice (2026-10-13)

- `lib/game-identities.js` centralises the generation/shape rules for simulated player identity values.
- New virtual workstation IPs have mixed 2-/3-digit IPv4 octets inside the private `172.16.0.0/12` range and are never derived from a player's real IP. The database uniqueness constraint is the final collision guard.
- Existing deterministic `10.x.x.x` IPs are upgraded on the player's next profile load. This migration is conditional and idempotent; new generated IPs do not match the old range.
- New First Bank account numbers are random eight-digit numbers, not an increasing user-ID sequence. Recognisable legacy server-generated numbers are upgraded on profile load while already-established eight-digit numbers are left unchanged.
- Player IP is loaded from the server before the post-auth page is rendered. SafetyShield OFF has red status text and a white cross over a red shield; ON remains green.
- The release plan and current-state ownership audit are in `NETSHIFT_V2_IMPLEMENTATION_PLAN.md` and `NETSHIFT_STATE_OWNERSHIP_AUDIT.md`.
- `npm run check` passes locally, including a new test of the identity formatting and account-number shape. **This is not a live Neon/Render migration test**; deploy to staging and confirm both existing accounts retain access, each has a stable different IP/account number, and SafetyShield presentation is correct before proceeding to the next phase.

## Remaining production gates

The state audit identified important legacy browser-authoritative state: money/ purchases, software/loadout, local desktop files/folders, older hack outcomes and Router access logs. Do not treat these as server-authoritative until their legacy code paths have been migrated and verified. The full release plan sequences those migrations and the new Archive/Recycle Bin, NPC, PvP, website catalogue, admin MFA and Hall of Fame features.


## Latest local implementation slice — 2026-10-13

- **Force Connect:** a password-verified login that finds an unreachable incumbent can offer an explicit takeover. The server checks that the incumbent has not become reachable, updates account ownership transactionally, and revokes the prior session. This has static checks only and must not be treated as staging-verified until tested with two browsers.
- **File UI foundation:** Core file API supports text file/folder creation, rename/content/location updates, an owner-scoped Recycle Bin, restore and permanent deletion. Right-click New Text Document creates a server-backed `Untitled.txt` with incremented names on conflict and opens an in-game Notepad window with editable filename and body. Server-backed files are hydrated into the UI after login and excluded from the legacy browser-submitted save blob. Old local inventory/software/upload handlers are still not fully migrated.
- **First Bank display:** My Computer displays `NONE` and hides the bank balance until the player has registered First Bank credentials, even when an account number is reserved server-side. User bank account creation/closure/recreation remains deferred; existing account history will need a non-destructive lifecycle model.
- **Password reset groundwork:** nullable `email_address` and `email_verified_at` fields plus a table for hashed, expiring, single-use reset tokens are created at startup. No email delivery, mailbox, verification or reset routes/UI exist yet. An in-game-only mailbox is not sufficient as a sole recovery method for a player who cannot log in.
- **Additional required mail feature:** initial domains `chainmail.net` and `badlook.com`, stable player/site/NPC identities, player-to-player mail, 1,000-message mailbox cap, levels 1–5 Spammer/Jammer (5–25 messages/hour; 80% same-level block baseline), unlevelled Spammer Commander, infected sender hijack, and deceptive/taunting Karmic Email attachments whose actual payload metadata remains server-side. This is planned as the next major feature after state/file/economy foundations, not implemented in this preview.

`npm run check` passes locally. The added checks are static/syntax assertions; no live Neon migration test, browser test of Force Connect, or end-to-end Notepad test was run for this slice.


## Latest Stage 1 local slice — Chunk 7 canonical inventory views (2026-10-13)

- Hydrated canonical file, software and folder records now use separate typed collections and retain server record IDs. Final Desktop and Explorer renderers cover Desktop, Downloads, Archive, nested custom folders and Recycle Bin using canonical paths; unknown software family/version rows stay visible under their stored server filename rather than receiving a guessed catalogue identity.
- Added owner-scoped transactional software location changes with family/level installation precedence. Restore preserves that precedence. Folder move/delete operations are deliberately refused until atomic descendant-path handling is implemented. Canonical records no longer write their locations into the legacy filename-keyed `state.localFileFolders` map.
- Authenticated hydration removes the legacy fictional-credential `bank-info.txt` demo row/icon without hiding a canonical server-owned file with the same name. Remaining legacy downloads, software, rewards, folder and recycle handlers are not all migrated; Chunk 8 addresses the canonical shared-host download flow, and Chunk 9 addresses remaining legacy writers.
- `npm run check` passes locally including `scripts/check-stage1-canonical-inventory.js`. Verification is static/helper-only: no PostgreSQL integration, browser/two-account run, GitHub write or deployment was performed. The game is not launch-ready.


## Latest Stage 1 local slice — Chunk 8 atomic shared-host downloads (2026-10-13)

- Added an authenticated host-inventory read, restricted to the player who currently controls that host, and wired the shared-host UI to claim canonical items through the server API. The client submits only the item ID; file type, name, content and software metadata are derived from validated host-stock records.
- `lib/host-download-claim.js` performs active session ownership verification, target/host locking, stock removal, claim-ledger insertion and canonical `/downloads` file creation in one transaction. File-name conflicts and unexpected insert errors roll back all changes; stale/reused item IDs are rejected.
- Added `scripts/check-stage1-host-download-claim.js` to the standard `npm run check` suite. Local mock-adapter checks pass for success, rollback, duplicate IDs, owner checks and concurrent claims.
- No live PostgreSQL, browser/two-account, staging, GitHub or deployment validation occurred. Remaining legacy client writers are still a Chunk 9 blocker; Stage 1 is not complete or launch-ready.
