# NETSHIFT Core v2 Preview — Staging Test Checklist

Run this only on `netshift-staging` with a disposable Neon staging database and disposable test accounts. Do not use real passwords or personal data.

## A. Deployment and service health

- [ ] Render build completes, including `npm run check`.
- [x] `/api/health` returns `ok: true`, `database: connected`, `realtime: enabled` (reported passing on 2026-10-13).
- [ ] The Render service is linked to `dev-multiplayer-v2` and `DATABASE_URL` points at the staging Neon project.
- [ ] Reload the game; registration/sign-in still works and the existing v1.3 World/chat functionality still works.

## B. Per-player profile and isolation

Register two disposable accounts in separate browser profiles. While signed in to each profile, open Developer Tools → Console and run:

```js
fetch('/api/core/profile').then(async r => console.log(r.status, await r.json()))
```

Expected for each signed-in account: HTTP 200; `profile.safetyShield` is `true` initially; a stable simulated `profile.ip`; and `profile.bank.balance` is 500. Account IPs must differ between the two accounts. Do not share or expose the output outside staging.

- [ ] Repeating the profile request returns the same simulated IP and account number for that account. After deploying the identity slice, confirm the IP is in the `172.16`–`172.31` private range with a mix of 2-/3-digit octets and the player account number is eight digits.
- [ ] The other account has a distinct simulated IP and separate account number.
- [ ] An unauthenticated browser receives HTTP 401 from the profile endpoint.

## C. SafetyShield first change and cooldown

Use a disposable account that has never changed SafetyShield. This preview allows the first toggle immediately; after that, the server enforces the one-hour cooldown.

```js
fetch('/api/core/safetyshield', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: false })
}).then(async r => console.log(r.status, await r.json()))
```

- [ ] First change returns HTTP 200 and `safetyShield: false`.
- [ ] Immediately attempt to set `enabled: true`; it returns HTTP 429 with `code: "SHIELD_COOLDOWN"` and a positive `remainingMs`.
- [x] `/api/core/profile` persisted the OFF state after refresh (reported passing on 2026-10-13). Recheck the red text / foreground cross visual after the identity/SafetyShield polish is deployed.
- [ ] A separate new account starts ON by default.

Do not try to reset the cooldown by editing the browser, save data, or database manually. The one-hour timer is intentional.

## D. First Bank setup, login and account isolation

Use two disposable NETSHIFT player accounts, A and B. Open First Bank (`firstbank.local`) while signed in as each player.

- [ ] An account that has not created bank credentials is prompted to choose a separate bank username and password.
- [ ] Account setup succeeds and authenticates the player's First Bank session.
- [ ] The bank overview shows that player's unique account number and the server-loaded $500 opening balance.
- [ ] Once First Bank is set up, My Computer shows the same account number and balance as the profile API, not the old fixed `100001` demo value. Before setup, My Computer shows account number `NONE` and does not show an unregistered balance. Verify the account number is random-looking (eight digits), stable on subsequent loads, and not generated sequentially from user ID.
- [ ] Reload the game. `/api/core/profile` reports the same account number; `bankSetup` remains true.
- [ ] After signing out of First Bank, the page asks for bank credentials again. Correct credentials work; an incorrect password is rejected.
- [x] Player A and B have different account numbers; using an already-taken bank username on the other account was rejected (reported passing on 2026-10-13).
- [ ] Repeating first-time setup returns HTTP 409 and does not reset existing credentials.

Optional diagnostic in Developer Tools Console, while signed in as each player:

```js
fetch('/api/core/profile').then(async r => {
  const d = await r.json();
  console.log(r.status, {
    bankSetup: d.profile?.bankSetup,
    accountNumber: d.profile?.bank?.accountNumber,
    balance: d.profile?.bank?.balance
  });
});
```

Never paste bank passwords, session cookies or other credentials into reports. **Transfers remain deliberately disabled** in this preview until the server-side transfer/ledger implementation is added; do not test legacy local demo transfers as if they were persistent.

## E. Player-file API ownership

Create a text file on Account A:

```js
fetch('/api/core/files', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'v2-test.txt', type: 'file', content: 'staging ownership test' })
}).then(async r => console.log(r.status, await r.json()))
```

Then run this on the same account:

```js
fetch('/api/core/files').then(async r => console.log(r.status, await r.json()))
```

- [ ] Create returns HTTP 201 and the file appears in Account A's list.
- [ ] Account B's file list does not contain Account A's file.
- [x] Editing and deleting Account A's server-backed test file using Account B's session both returned HTTP 404 (reported passing on 2026-10-13).

## F. Atomic shared-host download claim (Chunk 8 local implementation; runtime tests pending)

**Important:** the current implementation requires the signed-in account to be the current controller of the host. A probe alone is not enough; successfully breach the target first. The earlier reported checks in this section predate Chunk 8 and do not count as validation of the current host-control gate or transaction implementation.

### F1. Verify owner-only inventory read

After Account A has successfully breached and currently controls `finance`, list its inventory:

```js
fetch('/api/core/hosts/finance/inventory').then(async r => console.log(r.status, await r.json()))
```

- [ ] Account A, while current host controller, receives HTTP 200 and safe item metadata (no file content or private credential fields).
- [ ] Account B, who does not currently control `finance`, receives HTTP 403 from the inventory endpoint.

### F2. Claim a current item and verify canonical delivery

Use the `id` returned by the inventory response; do not assume a hard-coded ID remains available after a prior claim or regeneration.

```js
const inventoryResponse = await fetch('/api/core/hosts/finance/inventory');
const inventory = await inventoryResponse.json();
const itemId = inventory.items[0].id;
fetch('/api/core/hosts/finance/download', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ itemId })
}).then(async r => console.log(r.status, await r.json()));
```

- [ ] Current controller's valid first claim returns HTTP 200 and a canonical `file` record under `/downloads`.
- [ ] The new row appears exactly once in `GET /api/core/files` for Account A after refresh/re-login.
- [ ] Account B cannot see the claimed file in its private inventory.
- [ ] Repeating a consumed item ID returns HTTP 409 and does not award a second item.

### F3. Test rollback and concurrency on disposable staging only

- [ ] Create an active `/downloads` file with the same name as a stock item, then attempt to claim it. The API returns HTTP 409 `DOWNLOAD_NAME_CONFLICT`; the stock item remains available and no claim-ledger row or extra file is created.
- [ ] Submit two simultaneous requests for the same current item ID. Exactly one succeeds; the other receives HTTP 409; exactly one claim and one canonical file exist.
- [ ] Verify a regenerated item receives a fresh ID, can be claimed once, and that an old claimed ID cannot be reused even if it is reintroduced into stock.
- [ ] Verify an account that is no longer the host controller receives HTTP 403 at claim time even if it had previously opened the inventory view.

Chunk 8's new mock SQL adapter covers the transaction control-flow cases above. These manual cases are **not checked** yet: actual PostgreSQL row-locking, rollback and two-account browser behaviour still need to be demonstrated against a disposable staging database. Never use production for these tests.

### F4. Bounded, weighted host loot regeneration (apply only after deploying the regeneration fix)

- [ ] Confirm legacy overfull stock compacts to the configured limit on its next due regeneration: WHOIS-listed websites = 3 items; NPC workstations = 5 items.
- [ ] Verify the next five-minute regeneration never makes an inventory exceed its type limit. When full, the oldest *generated* loot item is replaced with a newly generated item; fixed/static website content is preserved.
- [ ] Confirm every new loot spawn has a fresh item ID and `generatedAt` metadata, and the same previous ID is not recycled.
- [ ] Confirm software family varies through the server-owned loot table rather than always producing Warez Virus L1. Current family weights: `crc` 18, `wwl` 15, `warez` 14, `fc` 10, `uploader` 11, `av` 13, `extractor` 6, `embedder` 6, `popup` 7.
- [ ] Confirm software level is weighted by the target's `security_level` (the shared-host firewall difficulty), with level weights [L1,L2,L3,L4,L5]: firewall 0 = [96,4,0,0,0], 1 = [86,12,2,0,0], 2 = [72,19,7,2,0], 3 = [60,23,11,5,1], 4 = [50,24,15,8,3], 5 = [40,26,18,11,5]. L1 remains the most common individual result; L5 is rare and increases in likelihood on higher-firewall targets.
- [ ] Confirm occasional text loot is selected from its own weighted table and does not expose credentials.
- [ ] Confirm a successful player claim immediately removes the item from authoritative host stock and refreshes the UI; a repeated claim of that ID cannot award it again.
- [ ] For any future NPC/security sweep removal, ensure the server updates the same locked `netshift_world_host_inventory.stock` row and increments `inventory_version`; never delete only a client-side array entry. Test the real removal action when that gameplay system exists.
- [ ] Confirm the `hacker` target is persisted as `npc_workstation`; WHOIS-listed seeded targets are `website`. Any future generated NPC workstation must set `target_type='npc_workstation'` explicitly.
- [ ] Verify the existing three-day `credential_lock_until` gate remains intact after regeneration changes.

The automated helper tests cover the weights, stock caps, oldest-generated replacement and recovery from an overfull legacy inventory. They do **not** prove PostgreSQL lock behaviour or multi-instance Render behaviour. For the live recovery test, record before/after inventory count, version and item IDs; a stock of 42 should fall to 3 for a website after the overdue regeneration is processed, rather than remaining over cap.

## G. Security and known exclusions

- [x] A regular test account received HTTP 403 from `/api/admin/viewusers` (reported passing on 2026-10-13).
- [ ] Do not provision an admin account: administrator MFA is not implemented/enforced in this preview.
- [ ] Do not test or advertise full PvP, NPC attacks, 30-minute post-hack immunity, full software gifting, money theft, or complete inventory regeneration as implemented yet. They are explicitly incomplete in `README_V2_STATUS.md`.

## Reporting

For each failed test, record the section, test account label (A/B only), HTTP status, error `code` if present, and a redacted Render log excerpt. Never include passwords, cookies, `DATABASE_URL`, `SESSION_SECRET`, or player bank credentials in the report.

## H. Next implementation backlog — added 2026-10-13

### H1. Full browser-state to server-state audit (priority)

Review the entire codebase, not only the current Core v2 endpoints, and inventory every gameplay property that is still authoritative only in browser state (including any local state, `localStorage`, client-side arrays/objects, save payloads, and legacy UI handlers). For each property, document its current storage location, intended authoritative server/database source, the API/socket events that read or mutate it, ownership/authorization rules, migration plan, and regression tests. Migrate properties to server-authoritative storage in staged, testable slices. The browser may cache/display state, but it must not authoritatively control protected state such as money, bank credentials/balances, inventory/software ownership, files, IP/workstation identity, SafetyShield/PvP state, world-host stock/claims, and hack outcomes.

### H2. Persistent desktop files and Windows 98 Notepad

- Connect right-click desktop text-file creation to `POST /api/core/files`; the created file must appear on the desktop and in the server-backed file list.
- Replace browser-native prompt/dialog flows with an in-game Windows 98-style Notepad window.
- New files should start with `Untitled`, auto-incrementing when the title is already occupied; both title/filename and body content must be editable in-game.
- Ensure edit/delete operations call the server API and preserve per-account isolation.
- Test create, rename, edit, close/reopen, reload persistence, and cross-account denial.

### H3. Shared-host downloads, inventory UI, and regeneration

- Connect all legacy download/freeware handlers to the server-authoritative host-claim and player-file/software inventory APIs; a successful API claim must update the owning player's `/downloads` inventory and the UI/desktop consistently.
- If an API download returns success but the browser UI does not show the item, treat that as a client/server synchronization bug.
- Clarify regeneration semantics in the UI and tests. Reclaiming the *same old item ID* should continue returning HTTP 409 after the original item has been claimed; a regeneration test must discover and claim the newly generated item ID rather than retry the exhausted ID.
- Complete inventory snapshot/restoration, duplicate prevention, restart-safe timer behavior, and exact five-minute/three-day lockout tests before marking regeneration complete.

### H4. Regression requirements

- Run `npm run check` after each migration slice.
- Test with two distinct accounts in separate browser profiles against the deployed staging service.
- Verify persisted state through server APIs after refresh and new login, not only by observing client-side UI.
- Never use production `main` or production database for destructive/ownership tests.


## H5. Additional product requirements confirmed 2026-10-13

- [x] SafetyShield OFF profile persistence was verified after refresh; visual change to red + foreground cross is now in the next local code slice and must be rechecked after deploy.
- [x] Player file ownership API returned HTTP 404 for both unauthorized edit and delete attempts.
- [ ] Test new identity migration on staging: existing users keep their account access; profile IP has the mixed IPv4 shape and remains stable after refresh; First Bank account number is a random eight-digit value and remains stable.
- [ ] Add server-backed PC facet API/UI for the Archive and Recycle Bin; later PC features must plug into the same target-PC extension model.
- [ ] NPC behaviour: 30 minutes accumulated active play grace, 15–60 minute attack scheduling, target-value-aware loot, stable IP, shared Router log clues/taunts, trace removal at 30 minutes, popup cycle and three-second antivirus window.
- [ ] Server-side shared workstation access logs visible to all players until the game's cover-track action deletes them.
- [ ] Enforce software gifting for every software family/level and make gifted/equipped Firewall count as actual PvP defence.
- [ ] Data-driven, varied website registry and five-minute WHOIS listing refresh with stable host addresses and discoverable hidden admin entry points on some sites.
- [ ] Google Authenticator-compatible TOTP, recovery codes and enforced MFA for every admin route before any admin role is used operationally.
- [ ] Network → Hall of Fame: explicit opt-in, pseudonym, warning not to reuse login username, server-derived score, rate limiting and public/private data separation.
- [ ] Use `NETSHIFT_V2_IMPLEMENTATION_PLAN.md` and `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` as the implementation order and source-of-truth inventory.


## H6. Authentication response discrepancy and future Router IP-change feature

- [ ] Investigate reported incognito result: `/api/core/profile` returns HTTP 200 in the authenticated regular browser session but HTTP 404 in Incognito. In the currently documented server implementation, `requireAuth` returns HTTP 401 with `AUTH_REQUIRED` for an unauthenticated session, so capture the Incognito request URL, status, content type and response body before treating 404 as expected. Confirm Incognito is on the exact `https://netshift-staging.onrender.com/` origin and that the deployed branch matches the source.
- [ ] Future feature: purchase an IP change in Router Admin for a configurable hefty fee using the server-authoritative ledger; assign a unique new virtual IP, persist the change record and preserve stability after refresh/relogin.
- [ ] Verify an active tracking virus still resolves/follows the victim's changed IP and records the change; after valid removal of the virus, the attacker must no longer receive updated-IP tracking. Test with two accounts and ensure the browser cannot submit arbitrary IPs or bypass payment.


## I. Latest local implementation slice — test only after deploying to staging

### I1. Force Connect (two browser profiles required)

- [ ] With an incumbent session actively connected, log in with correct credentials from a second browser: normal Yes/No handoff must be used; Force Connect must not be offered.
- [ ] Simulate an incumbent session that has no reachable Socket.IO connection but is still recorded as account owner. Correct credentials should show the Force Connect button after the login response.
- [ ] Cancel the Windows-style confirmation: no takeover occurs.
- [ ] Confirm Force Connect: request succeeds only while the incumbent still has no connected socket; ownership moves to the new session and old session requests fail ownership checks.
- [ ] Race test: if the incumbent reconnects between button display and confirmation, the server returns `ACTIVE_SESSION_REACHABLE` and refuses the takeover.
- [ ] Reload on the pending Force Connect browser and verify the explicit button remains available; reload of the old session must not silently release ownership.

### I2. Server-backed desktop files and Notepad

- [ ] Right-click blank desktop → New Text Document creates `Untitled.txt` server-side and opens the in-game Notepad. No browser-native prompt or Chrome dialog appears.
- [ ] Create a second text document; default name increments (for example, `Untitled (2).txt`).
- [ ] Edit file text and filename in Notepad; Save persists changes in `GET /api/core/files`. Close/reopen and refresh the browser: the current filename/content remain.
- [ ] Create a folder and confirm it appears after relogin. Open it and verify files moved into it persist.
- [ ] Move a server-backed file to Recycle Bin, restore it, then permanently delete a separate disposable file. Recycled filenames may be reused.
- [ ] Account B cannot list/read/edit/restore/delete Account A's file records. Cross-account mutation returns HTTP 404.
- [ ] Confirm server-backed file contents and IDs are not mirrored into the legacy `/api/save` document.

### I3. Password-reset schema and mail feature boundary

- [ ] Verify startup migration adds `email_address`, `email_verified_at`, `netshift_password_reset_tokens`, and `recycle_bin_at` without dropping player data.
- [ ] No claim of password reset/email delivery should be made until verification, delivery, token consumption and lockout/rate-limiting routes are implemented.
- [ ] Later email acceptance tests must cover the 1,000-message cap, player/site/NPC addresses, levelled spam/jammer rates, Commander infection, and deceptive attachment payload metadata.

## J. Deferred product requirements

- Future player bank-account create/close/reopen lifecycle. A closed account must preserve the transaction ledger; schema currently allows only one player bank account per user and will need an explicit migration to change that rule.
- Email will be the next major feature after the file/state/economy foundations: initial `chainmail.net` and `badlook.com` domains, extensible domain registry, player/site/NPC email addresses, era-appropriate mail UI, player-to-player email, 1,000-message mailbox limit, Spammer L1–L5 (5–25 emails/hour), unlevelled Spammer Commander, Spammer Jammer (80% same-level block baseline), spam infection, and Karmic Emails with actual server-side attachment identity separate from deceptive filenames.
- Accounts created before they have an email address must have a documented alternate recovery path; an inaccessible in-game mailbox cannot alone reset a forgotten login password.

## K. Stage 1 Chunk 7 — canonical inventory views and software locations

**Status:** Required staging/browser test matrix. The source-level checks pass locally; none of these runtime checks are claimed complete for Chunk 7 until run against the intended disposable staging deployment.

### K1. Canonical inventory hydration and view consistency

- [ ] Log in as Account A and confirm the required profile, active file, software and folder records are loaded before normal gameplay unlocks.
- [ ] Confirm canonical text files appear in Desktop, Downloads, Archive or their nested custom folder according to `parent_path`; open/rename/edit a text file and verify the server API returns the same record ID, parent path, name and content after refresh/relogin.
- [ ] Confirm canonical software rows do not appear as text documents. Known family/level records display appropriate catalogue metadata; unknown family/level records remain visible under the authoritative filename without guessed family mapping.
- [ ] Confirm software in Downloads/Archive/custom folders is not presented as already installed/runnable. Install or move it through the server API and verify the canonical location after reloading inventory.
- [ ] Confirm installing/restoring a lower-level software item does not replace a higher installed level of the same family; the lower level is moved to Archive when required by the location API contract.
- [ ] Confirm canonical folders use their full stored paths. Open a nested folder and verify its files and software are scoped to that path; moving/deleting folders must fail closed while atomic subtree operations are not implemented.
- [ ] Confirm Recycle Bin rows preserve the canonical stored name, `item_type`, and record ID for files, software and folders. File/software restore works subject to duplicate-name conflicts and software-level precedence. Folder recycle/permanent-delete requests are refused rather than orphaning children.
- [ ] Confirm a canonical server-owned `bank-info.txt` is visible by its canonical record ID, while the old local fictional-credential demo copy is discarded for an authenticated account.
- [ ] Create two canonical records with the same name in different folders (if the API contract allows those separate parent paths). Confirm their rendered mutations target the correct server record ID rather than selecting by filename.

### K2. Isolation, failure and concurrency

- [ ] Account B cannot see, move, open, restore or permanently delete Account A's canonical rows; verify API responses/status codes, not just the UI.
- [ ] Force an inventory refresh failure and confirm the last confirmed canonical mirror is preserved; the failure must not be presented as an authoritative empty inventory.
- [ ] Cause a filename conflict while saving/moving/restoring and verify the row remains in its prior canonical location or Recycle Bin state.
- [ ] Race software-location or restore requests for the same family from separate sessions and confirm family-level precedence remains consistent.
- [ ] Recycle and restore known software and an unknown software family; ensure the underlying server row ID is preserved and no duplicate row is created.

**Important limitation:** source-level tests and `npm run check` do not satisfy this section. Record any runtime result only after running against the intended disposable staging service and database; never run destructive migration tests against production.
