# NETSHIFT Core v2 — Implementation and Release Plan

This is the ordered implementation plan for the next release. It deliberately sequences dependencies to reduce rework, keep the architecture understandable for a future maintainer, and avoid destabilising production while gameplay mechanics are being migrated.

## Release principle

Develop and test only on `dev-multiplayer-v2` + `netshift-staging` + the staging Neon database. Keep `main` and its Neon project untouched. Make one coherent feature slice per commit, deploy that slice, test with two disposable player accounts, and only then continue. Never reset a database to resolve an application bug. The project owner has explicitly approved one early-development exception: a one-time reset/discard of legacy `netshift_saves.save_data` during the Stage 1 cutover. That exception must be version-gated, transactional and idempotent, must reject stale schema-v1 writes, and must not delete accounts or canonical server-side tables.

## Phase 0 — Baseline and deploy hygiene

- Preserve a known-good staging commit and verify branch/database identity before every deploy.
- Run `npm run check`; record a staging health check and the currently passing tests (SafetyShield persistence, First Bank account separation, file ownership 404s, download claim 200/409 and regular-player admin `viewusers` 403).
- Treat the current build as a preview, not production-ready. The health endpoint does not prove every gameplay path is correct.
- Add a changelog entry and test notes to every feature commit.

## Phase 1 — Identity and low-risk security/UI foundations (started)

- Use fictional private-range IPv4 workstation addresses that have a mixed 2-/3-digit octet pattern, unique under a database constraint, stable after assignment and never based on real client IPs.
- Use a random eight-digit player bank account number instead of a user-ID-derived sequence. Preserve established eight-digit numbers; migrate only recognisable legacy values.
- Display the server-assigned IP consistently across player-facing UI.
- Render SafetyShield ON in green with a shield; OFF in red with a clear foreground cross. Keep the setting/cooldown server-authoritative.
- Keep `.env`, `.env.*` (except `.env.example`) and `node_modules` out of Git.

**Current slice implemented locally:** identity helper module, best-effort safe migration on a player's next profile load, shield icon/text update and unit/static checks. It has not yet been deployed/live-tested against Neon.


## Stage 1 approved save-reset policy

The project owner has confirmed that current legacy save contents are disposable before the game has proper players. Stage 1 should therefore reset/ignore schema-v1 `netshift_saves.save_data` and default legacy browser-only state rather than spend time preserving or translating it. This does **not** authorize deleting accounts, server-side bank/profile/file/world records, or fabricating purchases from old client data. Implement the cutover once, atomically and idempotently; stale clients must not restore version-1 saves. See `NETSHIFT_STAGE1_MIGRATION_CONTRACT.md` and `scripts/fixtures/stage1-save-reset-cases.json`.

**Implementation status (Stage 1 Chunks 3–8, isolated local working copy):** `lib/legacy-save-cutover.js` applies the one-time legacy-save cutover before the HTTP listener starts. Chunk 4 adds a strict schema-v2 preferences-only save validator/writer, sanitised reads, account-ownership locking and optimistic revision checks. Chunk 5 updates the frontend to the preferences-only protocol. Chunk 6 now keeps the account overlay blocking, validates the required player-profile and active/Recycle Bin inventory responses, pauses authenticated gameplay timer callbacks while hydration is pending, and creates the autosave timer only after successful required loads. `preferences.lastAddress` remains the sole saved preference. Chunk 7 now reconciles canonical file/software/folder rows with the Desktop, Downloads, Archive, custom-folder and Recycle Bin views. Chunk 8 adds an owner-authorised host inventory read and an atomic host-stock/claim/canonical-file transaction with conflict rollback and concurrency tests. This is not deployable: PostgreSQL and browser/two-account integration remain unverified, and remaining legacy mutation reconciliation is outstanding.


## Stage 1 — revised bounded implementation chunks

The following smaller-chunk sequence supersedes older, broader chunk groupings for the current Stage 1 work. Each implementation operation ends with a checkpoint and owner review; do not start the next chunk without that review.

| Chunk | Scope | Recorded status |
|---|---|---|
| 0 | Recover baseline, identify deployed root source, compare hashes and run existing checks | Previous checkpoint reports complete locally; remote branch is not connected in this runtime |
| 1 | Audit server/client state ownership and record actual mutation paths | Audit checkpoint exists; source and runtime validation still have limits |
| 2 | Approve legacy-save reset boundary and add synthetic contract fixtures | Recorded complete in prior checkpoint |
| 3 | Implement the named one-time reset receipt/transaction and retire schema-v1 saves | Recorded locally implemented; PostgreSQL transaction semantics remain unverified |
| 4 | Add the server-side schema-v2 preferences-only save allowlist and revision protocol | Implemented locally; static/unit tests pass |
| 5 | Move client save/restore/conflict/page-hide paths to preferences-only schema v2 | Implemented locally; checks pass |
| 6 | Gate authenticated gameplay and autosaving on successful profile and canonical inventory hydration | Implemented locally in this checkpoint; browser runtime validation remains outstanding |
| 7 | Reconcile canonical files/software with Desktop, Downloads, Archive, Recycle Bin and installed-software views without duplicating records | Implemented locally; static/helper checks pass; browser/PostgreSQL verification pending |
| 8 | Make host-stock claim, claim ledger and canonical player-file delivery atomic, including filename-conflict rollback and concurrency tests | Implemented locally; mocked transaction/static checks pass; PostgreSQL/browser validation pending |
| 9 | Reconcile or retire remaining legacy browser-side inventory/download/folder/recycle writers so they cannot create competing authority | Pending |
| 10 | Run final Stage 1 regression/acceptance checks and update the ownership matrix with evidence | Pending; Stage 1 cannot be declared complete before this gate |

The chunks are small by design. A locally passing static suite does not establish PostgreSQL behaviour, browser correctness, account isolation or launch readiness. The project owner controls GitHub operations and deployment.


## Stage 1 — atomic shared-host downloads (Chunk 8, local only)

- Added `lib/host-download-claim.js` to perform the stock update, `netshift_world_loot_claims` insert and canonical `netshift_player_files` delivery as one transaction. The canonical file insert no longer swallows conflicts with `ON CONFLICT DO NOTHING`; a filename uniqueness conflict rolls back all related writes and returns HTTP 409. Other failures also roll back.
- The transaction validates active session ownership, then locks the target and host inventory in the same ownership → target → host order used by the breach path. A player must currently control the host (`compromised_by_user_id`) to claim stock. The authenticated host-inventory read endpoint applies the same access rule and only returns safe item metadata.
- Client requests submit only a host item ID. The server obtains item name, type, content, software family and level from validated server-side stock; invalid or duplicate stock IDs and missing software metadata fail closed. Previously claimed item IDs are refused even if reintroduced into stock; regeneration must use a fresh item ID.
- Connected the shared-host UI to `GET /api/core/hosts/:slug/inventory` and `POST /api/core/hosts/:slug/download`. On success, the client refreshes canonical player files rather than manufacturing a local item.
- Added `scripts/check-stage1-host-download-claim.js` to `npm run check`. Its mock SQL adapter covers successful delivery, filename-conflict rollback, unexpected file-write rollback, duplicate-ID rejection, current host ownership, trusted metadata and one-winner concurrent claims.
- Validation: full `npm run check` passes locally. The adapter is not PostgreSQL; no actual PostgreSQL transaction/isolation test, browser/two-account run, staging deployment, GitHub operation or production action has occurred. Retain these as release blockers. Remaining legacy download and inventory writers belong to Chunk 9.

## Phase 2 — Complete the state-ownership audit and introduce clean service boundaries

- Finish `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` against every property and write path in the current client/server source.
- Introduce small, named server-side services (identity/profile, player files/inventory, banking/ledger, world hosts, attacks, NPCs, leaderboard) and route files that receive dependencies explicitly. Avoid a risky all-at-once rewrite of the large legacy HTML script; cut over one slice at a time.
- Give the player save blob an explicit versioned schema. Stop accepting protected gameplay fields from the browser save payload; use an allowlist for cosmetic/tutorial preferences and dedicated API mutations for protected state.
- Use explicit, idempotent migration helpers and synthetic fixtures. The owner-approved legacy-save discard is the sole intentional reset exception; test it first without a live database, then against a disposable staging database only.

**Gate:** every protected field has one documented authority and every route changing it is inventoried before further complex mechanics depend on it.

## Phase 3 — Canonical files, desktop, archive and recycle bin

- Make `netshift_player_files` (or a future unified inventory/files model) the single source of truth for desktop files, folders and text content.
- Replace browser-native prompts with a Windows 98-style in-game Notepad window. New file title begins `Untitled`, incrementing when occupied; title and content remain editable.
- Synchronise Explorer, desktop icons, opening/editing/renaming/deleting files and `/downloads` with server state, including after reload/relogin.
- Make Recycle Bin behaviour, connection-log deletion and draggable desktop icon state work through deliberate persisted APIs where required.
- Add reusable target-PC capabilities/facets so a successful hack grants the access allowed by the target: overview, Archive, Recycle Bin and later extensible sections without another monolithic rewrite.
- Apply software ownership records to every software family and level, not just Firewall. Gifting is a gameplay action for transferring an item, and hijacked PCs expose data the target actually owns.

**Gate:** create/edit/rename/delete/reopen works; successful download appears both in `/downloads` and UI; two accounts cannot read/edit/delete each other's private files; concurrent gifts/claims cannot duplicate ownership.

## Phase 4 — Authoritative economy and transaction ledger

- Move player money/wallet state, purchases, upgrades, Warez cashout and any transfers off `state.accounts.player.balance` and onto server-side records.
- Implement atomic debit/credit transactions and a ledger with idempotency keys, sufficient-funds checks and rollback on failure. Disable unreconciled legacy economy actions until wired in.
- The only current intended income path is money recovered from stolen **NPC bank credentials**. Model NPC credentials and their loot independently from player First Bank accounts.
- Software/workstation inventory regenerates five minutes after the last successful intrusion; recovered NPC bank loot values replenish 30 minutes after the last theft from that NPC account. Preserve the stated three-in-game-day host lockout when credential loot triggers it. Define how the five-minute stock timer interacts with credential-bearing inventory explicitly in the service and tests rather than duplicating timers across the client.
- Add the Hall of Fame under Network with explicit opt-in. The player chooses a public pseudonym, is warned not to use their login username, and the server derives the submitted money/score from authoritative records. Reject case-insensitive matches with their login username, sanitise/rate-limit public names, prevent duplicate submissions and show only pseudonym/score/rank publicly. Internally link submissions to accounts only for abuse prevention; do not label this as absolute anonymity.
- Add a Router Admin IP-change purchase. Charge a configurable, deliberately hefty fee through the authoritative transaction ledger, issue a new unique fictional IPv4 address, and persist the change and timestamp. Do not let the client choose an arbitrary address or change identity for free. Keep exact fee/balance rules configurable for future tuning.

**Gate:** balance cannot be altered via DevTools or `/api/save`; no negative/duplicated money under concurrent actions; NPC loot cannot expose/modify any player's actual First Bank account.

## Phase 5 — Shared PC records and PvP resolution

- Maintain a shared server-side access/admin log per workstation. Every player sees the same target log unless it has been deleted under game rules; two players accessing the PC close together must see both visits in the correct order.
- Implement IP changes as a logged Router Admin action. An IP change must update the player's canonical identity without wiping active infection/trace relationships; a virus that is still installed and linked to a hacker must be able to report or follow the victim's new IP, even when the router log records the change. Removing the virus first should break that tracking path.
- Add attack validation for SafetyShield, attacker Waterwall, target Firewall, active session ownership, target access and post-success immunity. Firewall/Waterwall are never deletable in PvP; other loot/deletion rules are server-defined.
- Successful player hack grants 30 minutes of hack immunity to the victim; server timestamps, not client clocks, decide.
- Implement gifting/trading as an authorised inventory mutation and use equipped/gifted Firewall as actual defence.
- Make successful attacks reveal eligible target-PC Archive/Recycle Bin data only through authorised target access; keep a clear audit trail and transaction boundary.
- Define money-theft amount/limits before implementing that mechanic; this is a deliberate balancing decision, not permission to invent economy rules. It can build on the ledger in Phase 4.

**Gate:** two-browser tests for simultaneous attacks, cooldowns, shield ON/OFF, insufficient Waterwall, protected software, ownership transfer and shared logs.

## Phase 6 — Email service, account recovery and spamware (next major feature)

Build email on the server-side identity, file and malware foundations, not as another local browser inbox.

- Provide an era-appropriate email UI with server-owned messages, folders, read/unread state and attachment metadata. A mailbox can contain at most 1,000 messages. Block/score spam before mailbox insertion so the cap and Spammer Jammer matter.
- Support player-to-player messaging. Give mail identities to players, NPCs and WHOIS sites. Start with `@chainmail.net` and `@badlook.com`; keep domains data-driven so more can be added. Site identities correspond to their website. Generate NPC local parts from word dictionaries plus numbers; ensure addresses are unique and stable.
- Make `netshift_email_accounts`, `netshift_emails`, recipient delivery, attachment records and spam-delivery events server-authoritative. Enforce per-mailbox limits and anti-abuse/rate limits transactionally. The browser must not be able to forge sender identity, attachments, inbox count or malware level.
- Implement Spammer and Spammer Jammer software levels 1–5. Spammer L1 targets 5 messages/hour; L5 targets 25/hour, with levels scaling between. Spammer Commander has no level and extends/commands spam activity according to a documented behaviour contract before its code is written. Spammer Jammer blocks 80% of same-level spam, more from weaker spammers and less from stronger ones. Keep the percentage curve configurable and testable; spam should remain possible, never universally zeroed.
- Uploading/infecting a workstation with Spammer or Spammer Commander can hijack that player's email identity to send spam. Spammer Jammer is an anti-spam countermeasure. Infection state, sender attribution and the messages actually sent must be server-owned; UI notifications are presentation only.
- Add Karmic Emails from players and NPCs, delivered on a configured random schedule. Attachments may be helpful software from a friendly hacker or taunting/malicious payloads. The visible filename may deliberately misrepresent the payload (for example, a fake utility name), so the server stores the real asset/type/family/level/signature separately and execution checks the real metadata, not the filename or extension. Tracking and opening the attachment must create auditable inventory/infection events.
- Account recovery: support nullable email identity on existing/new player accounts, verification before it can be used for recovery, expiring single-use password-reset tokens stored only as hashes, rate limiting and audit events. Accounts and First Bank accounts may exist before a mail identity is created; bank credentials are never used as the platform password-reset credential. Add an external/independent recovery factor or a documented manual recovery route for accounts that have no verified address, because a fictional in-game mailbox by itself cannot be accessed while the player is locked out.
- The local schema groundwork now includes nullable `email_address` / `email_verified_at` user fields and a password-reset token table. Email delivery/UI, email identities, inbox tables, virus integration and working resets are **not implemented yet**; add them in the email phase with explicit migrations and tests.

**Gate:** player mail round-trip; stable site/NPC addresses; mailbox capacity; rate limiting; 1,000-message boundary; spam rates; jammer curve; infected sender attribution; valid/invalid attachment handling; recovery-token expiry/reuse rejection; and recovery behaviour for accounts that existed before they had email.

## Phase 7 — NPC scheduling, behaviour and malware presentation

- Give each player 30 minutes of server-recorded active play time before NPC attack timers begin; do not count mere wall-clock time offline.
- Run the 15–60 minute NPC attack scheduler on the server. NPC identities/IPs are stable; attacks use real NPC Waterwall/target Firewall values and persist outcomes.
- NPCs evaluate a target's server-side inventory and prefer valuable/high-level files/software when their behaviour permits it. Stolen items become visible on the attacker's NPC workstation/download records so a player who tracks and hacks that machine can recover eligible loot. NPC taunts can describe the actual theft/infection without claiming actions that did not occur.
- Record intrusion details in the target's shared Router admin log. Use staged IP obfuscation, clues, taunts or plausible mistakes that can let an attentive player identify the attacker; expire/remove the trace 30 minutes after the intrusion, not immediately. Don't make obfuscation purely random if it is meant to be solvable.
- Make popup spam larger and more frequent, with varied late-1990s/early-Web-style advertisements and messages. After a randomly selected 2–10 user closes, pause popups for 3 seconds so antivirus can be selected/launched. The infection/attack source stays server-owned; the UI effects remain client presentation.
- Active tracking viruses retain a server-side association between the compromised workstation and the attacker. Changing a virtual IP must update what an active tracking virus observes; deleting/quarantining that virus through valid gameplay action breaks the association. Do not rely on a client-side flag to decide whether tracking continues.

**Gate:** simulate scheduler deterministically in tests, prove no attacks before 30 active minutes, verify item theft/log clue/restoration, and test popup close counts/pause/antivirus interaction.

## Phase 8 — Website catalogue and exploration

- Replace the growing hard-coded website list with a data-driven site registry plus reusable page templates and per-site content/components.
- Add richer variation in themes, layout, services, security level, rewards, items and behaviour, retaining distinct identities and stable addresses.
- Some sophisticated sites hide admin entry behind discoverable page links/content; ensure the path is discoverable through deliberate exploration, not blind/random clicks.
- WHOIS connected-IP entries refresh every five minutes while site addresses remain stable. Add variety while preventing collisions and making newly regenerated content discoverable.
- Keep browser-facing site templates separate from the attack/inventory backend so new websites, software, minigames and NPC/player interactions can plug into existing interfaces rather than copy/paste a new monolith.

**Gate:** stable IPs after refresh, unique addresses, five-minute listing refresh, diverse page-template tests, predictable discoverability and no client-trusted security/reward decisions.

## Phase 9 — Administrator MFA and hardened moderation

- Use TOTP compatible with Google Authenticator. Provide an authenticated enrollment screen and QR/secret setup, require proof of a current code, then require verified MFA for every admin route/session. Encrypt TOTP secrets at rest using a separately managed deployment secret; never commit keys. Hash one-time recovery codes and invalidate each on use.
- Don't provision operational admin roles until enrollment/verification tests pass. Keep operator-controlled role grants outside public APIs.
- Make kick/ban revoke Express sessions and live sockets; all protected routes check ban state. Provide unban, online-first `viewusers` and admin-private logs with audit events.
- Add rate limiting, anti-CSRF protection where appropriate for cookie-authenticated mutations, schema validation, role checks, error handling and log redaction.

**Gate:** ordinary player gets 403; admin without MFA gets 401/403 on every route; valid TOTP permits access; replay/invalid codes rejected; kick/ban disconnects and denies subsequent requests; recovery-code handling and audit trail validated.

## Phase 10 — Release certification and future extensibility

- Add API integration tests against a disposable PostgreSQL database and two-account browser tests on Render/Neon staging.
- Run static syntax checks, migrations from both a fresh database and an existing v1.3/v2 preview database, race tests for claims/transfers/attacks and reload/restart persistence checks.
- Verify backups and a rollback plan. For rollback, prefer reversible feature toggles or a known-good commit; do not remove columns/records as part of ordinary rollback.
- Keep additional software, minigames, NPC personalities and player-to-player interactions as extension points built on services and typed game actions. They need not all ship in this release; the architecture must make adding them predictable.
- Promote to production only after all explicit release gates pass; health endpoint success alone is insufficient.

## Agreed product requirements captured

- Authentication: after password verification, if the incumbent account session cannot be reached, offer a clearly warned Windows-style **Force Connect** action. The server must re-check the incumbent is still unreachable at takeover time, revoke the old session, and refuse Force Connect if the incumbent reconnects; ordinary reachable sessions retain the existing Yes/No handoff flow.
- My Computer must display the bank account number as `NONE` until the player registers with First Bank, even if a random account number is already reserved server-side. Creating and closing/recreating player bank accounts is a later banking feature; use a closed-account/active-account model and preserve the ledger rather than hard-deleting financial history.
- Email recovery: existing player and bank accounts can predate in-game email. Keep bank credentials independent from NETSHIFT account credentials. A mailbox-only recovery is circular if the mailbox itself requires the forgotten password, so support a verified external recovery channel or a separately issued recovery factor for accounts without one.
- Email: the next major feature after current file/state and economy foundations. Initial domains are `chainmail.net` and `badlook.com`, with a data-driven allowlist for later domains. Give players, NPCs and WHOIS sites stable identities; generate NPC aliases from a dictionary plus digits. Use an era-appropriate interface and server-authoritative inboxes, recipients and attachments; enforce a 1,000-message mailbox cap.
- Email malware: Spammer levels 1–5 send 5–25 messages per hour (linear level scaling); Spammer Commander has no level; Spammer Jammer blocks 80% of equal-level spam and increasingly less from stronger, increasingly more from weaker, spammers. Spam remains possible. Infections can hijack a workstation's mail identity to send messages.
- Karmic Emails: player/NPC messages may carry helpful software or deceptive/taunting malicious attachments. The displayed filename can disguise the real payload; server-side asset metadata, not filename/extension, decides what executes.
- Additional future bank account lifecycle: players will eventually be able to create and close accounts, but not in this slice. Preserve transaction history, allow a player to open a new account after closure, and avoid the current one-account lifetime unique constraint in that later migration.

- Player virtual IPs have an IPv4 appearance with 2-/3-digit octets; bank account numbers look realistic and random rather than sequential.
- SafetyShield ON is green; OFF is red and has a foreground cross over the shield.
- Software gifting applies to all software and represents a player-to-player interaction/data hijack capability, not a Firewall-only special case.
- Hacked PCs expose Archive and Recycle Bin plus extensible future PC sections.
- NPCs cover tracks, provide clues/taunts, prioritise valuable files, can loot bank credentials, and their trace disappears only after 30 minutes.
- Popup spam is larger, more frequent and varied; after 2–10 closes a 3-second lull permits antivirus use.
- NPC attacks wait for 30 minutes of accumulated active play time per account.
- Software inventory replenishes five minutes after last successful intrusion; stolen NPC bank account values replenish after 30 minutes; NPC credential hosts retain the three-day lockout rule to prevent the stated exploit.
- Shared workstation access logs reveal addresses across players until properly deleted/expired.
- WHOIS/site catalogue gets greater variety and stable addresses, with some admin login pages found through exploration.
- Admin MFA uses Google Authenticator-compatible TOTP.
- Network gets a consent-based Hall of Fame with a chosen public pseudonym and a warning not to reuse the account login username.
- Future software, minigames and player/NPC interactions should be easy to extend through services and site/PC capability registries.
- Router Admin IP-change purchase: high configurable fee, newly generated unique virtual IP, a persistent change record, and virus-aware tracking. Verify the changed IP is stable after reload and that an active tracker still follows it until the virus is removed.

## Latest implementation slice — files, Force Connect and email-recovery groundwork

- The server-owned file API now supports a recycle-bin timestamp, recycle-bin listing, restore, permanent deletion, and editing filename/content/location in a single owner-scoped API operation. Active filenames are unique within a player/path while files in the Recycle Bin no longer reserve the name. This is an additive migration but still needs testing on staging.
- Right-click New Text Document no longer uses browser `prompt()` dialogs. It creates a server-backed `Untitled.txt` (or incremented `Untitled (2).txt`, etc.) and opens an in-game Windows 98-style Notepad with editable filename and body text. The UI loads canonical file records after account login and excludes server-linked file data from the legacy client save payload. Full reconciliation of every old local inventory handler remains outstanding.
- Core file records are rendered in desktop/Explorer views and Recycle Bin operations call the owner-scoped APIs. Rename, edit, move, restore and permanent-delete flows have static/syntax checks only; verify them interactively on staging.
- Added a password-verified Force Connect flow for an unreachable incumbent session. The endpoint rechecks reachability at the point of takeover and refuses a takeover if the old session is reachable; a Windows-style confirmation warns that unsaved progress can be lost. This is security-sensitive and must be tested with two browser profiles before relying on it.
- My Computer now shows `NONE` and no bank balance until First Bank credentials are set up, even though the server may already have reserved the random account number.
- Added nullable user email/verification fields and hashed, expiring, single-use password-reset token schema groundwork. No email delivery, mailbox or password-reset route/UI is implemented yet.
- `npm run check` passes locally, including added static checks for the new file UI/API and Force Connect markers. No live Neon/Render database migration or browser integration run has been performed for this slice.


## Stage 1 — canonical inventory view reconciliation (Chunk 7, local only)

- Split hydrated canonical records into typed server-backed collections for files, software and folders. Text files alone enter `state.localFiles`; software rows are represented separately and mapped to local catalogue IDs only when family/level match known metadata. Unknown software remains visible by its canonical stored filename and record ID rather than being guessed or dropped.
- Desktop, Downloads, Archive and nested custom Explorer views render canonical rows using stable server record IDs. Canonical software is shown as installed only when its canonical location is the Desktop; software in Downloads/Archive/custom folders must request a server-authorised move/install rather than execute directly. Canonical folders retain full paths, and Recycle Bin rows preserve server item type, stored filename and record ID.
- Added the owner-scoped `PATCH /api/core/files/:id/location` software-location operation. Installation/location changes are transactional, lock and arbitrate software-family/level state, and retain a higher installed level while archiving lower copies as required. Restore uses the same family-level precedence. Generic recycle/permanent-delete endpoints refuse folders because atomic child-path operations are not yet implemented. Parent paths are validated to prevent malformed/non-canonical destinations.
- The legacy filename-keyed `state.localFileFolders` map is now transitional-only; canonical path state comes from each server record's `parent_path`. Canonical Notepad saves and hydration no longer write canonical paths into that ambiguous map. Authenticated hydration discards the legacy fictional `bank-info.txt` demo item while leaving any canonical server-owned record with that name visible.
- Added `scripts/check-stage1-canonical-inventory.js` to the standard check suite. Local tests cover typed mapping, record ID preservation, view wiring/rendering, unknown catalogue families, legacy duplicate hiding, software location route markers, restore precedence and invalid path rejection.
- Validation: full `npm run check` passes locally. These are static/helper tests, not a browser test; no PostgreSQL, live staging, two-account browser, GitHub write or deployment occurred. Folder move/rename/delete remains deliberately disabled until a safe atomic subtree/path operation is designed. Chunk 8 now implements the local atomic host-download path; remaining legacy writers remain Chunk 9.
