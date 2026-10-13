# NETSHIFT Core v2 Preview — Staging Test Checklist

Run this only on `netshift-staging` with a disposable Neon staging database and disposable test accounts. Do not use real passwords or personal data.

## A. Deployment and service health

- [ ] Render build completes, including `npm run check`.
- [ ] `/api/health` returns `ok: true`, `database: connected`, `realtime: enabled`.
- [ ] The Render service is linked to `dev-multiplayer-v2` and `DATABASE_URL` points at the staging Neon project.
- [ ] Reload the game; registration/sign-in still works and the existing v1.3 World/chat functionality still works.

## B. Per-player profile and isolation

Register two disposable accounts in separate browser profiles. While signed in to each profile, open Developer Tools → Console and run:

```js
fetch('/api/core/profile').then(async r => console.log(r.status, await r.json()))
```

Expected for each signed-in account: HTTP 200; `profile.safetyShield` is `true` initially; a stable simulated `profile.ip`; and `profile.bank.balance` is 500. Account IPs must differ between the two accounts. Do not share or expose the output outside staging.

- [ ] Repeating the profile request returns the same simulated IP and account number for that account.
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
- [ ] `/api/core/profile` persists the OFF state after refresh.
- [ ] A separate new account starts ON by default.

Do not try to reset the cooldown by editing the browser, save data, or database manually. The one-hour timer is intentional.

## D. First Bank setup, login and account isolation

Use two disposable NETSHIFT player accounts, A and B. Open First Bank (`firstbank.local`) while signed in as each player.

- [ ] An account that has not created bank credentials is prompted to choose a separate bank username and password.
- [ ] Account setup succeeds and authenticates the player's First Bank session.
- [ ] The bank overview shows that player's unique account number and the server-loaded $500 opening balance.
- [ ] My Computer shows the same account number and balance as the profile API, not the old fixed `100001` demo value.
- [ ] Reload the game. `/api/core/profile` reports the same account number; `bankSetup` remains true.
- [ ] After signing out of First Bank, the page asks for bank credentials again. Correct credentials work; an incorrect password is rejected.
- [ ] Player A and B have different account numbers and distinct bank usernames/credentials.
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
- [ ] Editing or deleting Account A's file using Account B's session returns HTTP 404.

## F. Atomic shared-host download claim

The preview's host seed includes `finance-warez1` on the `finance` host. On Account A, claim it:

```js
fetch('/api/core/hosts/finance/download', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ itemId: 'finance-warez1' })
}).then(async r => console.log(r.status, await r.json()))
```

- [ ] First claim returns HTTP 200.
- [ ] A second claim of the same item (from either account) returns HTTP 409 with an unavailable-item error.
- [ ] The claimed item is added to the winning player's server-side `/downloads` file inventory.

This validates the single-winner server-side claim endpoint. Full migration of all legacy freeware/upload interactions remains unfinished.

## G. Security and known exclusions

- [ ] Confirm a regular test account receives HTTP 403 from `/api/admin/viewusers`.
- [ ] Do not provision an admin account: administrator MFA is not implemented/enforced in this preview.
- [ ] Do not test or advertise full PvP, NPC attacks, 30-minute post-hack immunity, full software gifting, money theft, or complete inventory regeneration as implemented yet. They are explicitly incomplete in `README_V2_STATUS.md`.

## Reporting

For each failed test, record the section, test account label (A/B only), HTTP status, error `code` if present, and a redacted Render log excerpt. Never include passwords, cookies, `DATABASE_URL`, `SESSION_SECRET`, or player bank credentials in the report.
