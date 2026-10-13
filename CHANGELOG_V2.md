# NETSHIFT Core v2 preview changelog

## Added
- Authoritative player profile schema and stable simulated workstation IP assignment.
- Isolated First Bank player account records with bcrypt-hashed in-game bank passwords.
- Server-backed SafetyShield setting and one-hour cooldown API, plus Windows-style confirmation UI in My Computer.
- Player file/folder/text CRUD API with ownership checks and soft deletion.
- Shared-host stock records and atomic one-winner download claim endpoint preserving software family and level.
- Inventory refresh ticker foundation and credential lockout field.
- Admin roles, audit schema, bans, user listing and moderation endpoints; operator-only grant CLI.

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
