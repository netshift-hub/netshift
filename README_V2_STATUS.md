# NETSHIFT Multiplayer Core v2 — implementation preview

This package is an incremental development build based on v1.3. It is **not yet a production-ready multiplayer release**. It includes the next server-authoritative foundations and a visible SafetyShield control, while full gameplay integration and real database/runtime testing remain outstanding.

## Implemented in this preview

- Additive PostgreSQL schema for persistent player world profiles, stable simulated workstation IPs, player bank records, player files, shared-host inventory/loot claims, admin roles/audit events and account bans.
- Player world profile creation on registration/login. First Bank player records are distinct from NPC account-file loot; the opening balance is $500. In-game bank password setup is exposed through `/api/core/bank/first-login` and stores a bcrypt hash.
- SafetyShield UI in My Computer, ON by default, with Windows-style confirmation dialog and server-side one-hour change cooldown. PvE is not disabled by SafetyShield.
- Authenticated file CRUD API for creating folders/text files, reading current player files, editing text, and soft-deleting files.
- Atomic shared-host download claim endpoint. Concurrent attempts for the same stock item cannot both win; a losing attempt gets an availability error. The endpoint adds the claimed file/software to the player's server-side file inventory while preserving software family and level metadata.
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
- Canonical player-to-player software gifting/trading and a single source of truth shared by existing gameplay UI and the new server-side file inventory.
- Integrate existing NefariousUploader and all legacy download/upload flows with server-owned file/software IDs; the legacy browser UI still has local-state flows that are not yet fully migrated.
- Correct and verify the legacy Warez L1–L5 upload bug, database file contents, bank account UI/login flow, connection-log deletion, Recycle Bin delete-all, draggable desktop positions, pinned WHOIS listings, and full right-click Explorer operations against the persistent API.
- NPC attacks on a server-side 15–60 minute schedule, real simulated NPC addresses, router admin intrusion logs and probability tuning. The ticker is only an initial regeneration foundation and still needs item-snapshot-based exact inventory restoration and money-loot transaction rules.
- Regeneration based on the last successful intrusion, with full three-day credential lockout semantics, restart-safe scheduling, and tests that prove no duplicate stock or currency.
- Enforce Firewall L1–L6 as actual defensive state and Waterwall L1–L6 as offensive state in every relevant legacy hack flow.
- Enforce MFA for administrators, socket disconnection on kick/ban, ban enforcement on all existing authenticated routes, and audit-log tamper-resistance controls.
- Add transactional player bank transfers/ledger, player-to-player PvP theft limits, and full authoritative save migration so browser-submitted legacy saves cannot overwrite protected account/economy fields.
- End-to-end test against a disposable PostgreSQL database, then two separate browser profiles against a deployed staging instance. This preview has only static/syntax checks; it has not been tested against live PostgreSQL, Render or Neon.

## Staging preview update (2026-10-13)

- Corrected SafetyShield cooldown initialization: the default ON setting may be changed once immediately; the one-hour cooldown begins after the first actual change. The change state is persisted in `shield_has_been_changed` so it survives restarts.
- Updated `.gitignore` to exclude `.env.*` while explicitly preserving `.env.example`.
- Added `NETSHIFT_CORE_V2_STAGING_DEPLOYMENT.md` and `NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md` for controlled staging rollout and API validation.

## Verification

Run `npm run check`. It checks server syntax, embedded client JavaScript syntax, existing multiplayer tests and static Core v2 feature markers. It does not replace integration tests against PostgreSQL.

## Existing deployment environment

The package retains the existing `DATABASE_URL` and `SESSION_SECRET` configuration. Database schema changes are additive and run at application startup. Back up the database before staging this build. Do not deploy to production until the outstanding security and gameplay items above have been completed and tested.
