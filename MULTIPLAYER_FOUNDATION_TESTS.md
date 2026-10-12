# NETSHIFT Online v1.1 — Multiplayer Foundation Test Checklist

Use two different test accounts in separate browser profiles. Do not share real personal data or credentials. Run these tests on the deployed Render URL after the v1.1 deploy is live.

## Deployment and authentication

- [ ] `/api/health` returns `ok: true`, `database: connected`, `realtime: enabled`.
- [ ] Login page and existing account sign-in still work.
- [ ] Existing account saves still load after deploy; existing saves are migrated to revision 1 without reset.
- [ ] Browser refresh loads the latest HTML rather than a stale cached client.

## Real-time presence

- [ ] Sign into account A in browser profile A and account B in profile B.
- [ ] Click **World** in both profiles. The two public usernames appear in both operator lists.
- [ ] Both panels show `Connected` and the correct unique operator count.
- [ ] Log account B out. Profile A receives the updated presence list after B's socket disconnects.
- [ ] A second session using the same account is listed once, not as duplicate operators.
- [ ] Logging out one session only closes that session's socket; it does not incorrectly close another authenticated session for the same account.

## Shared world event slice

- [ ] The public target registry displays the seeded sites and security level metadata.
- [ ] Account A probes a target. The request succeeds and the target probe counter increments.
- [ ] Account B receives `world:event` and `world:target-updated` without refreshing.
- [ ] Account B refreshes. The probe count and event remain in the server-rendered snapshot from PostgreSQL.
- [ ] An unauthenticated request to `GET /api/world/summary` returns 401.
- [ ] An unauthenticated request to `POST /api/world/targets/finance/probe` returns 401.
- [ ] A made-up target slug returns 404 and does not add an activity event.
- [ ] Repeated probe requests eventually hit the rate limit and do not continue incrementing indefinitely.

## Save concurrency protection

- [ ] Ordinary manual save succeeds and advances the save revision.
- [ ] Automatic save succeeds and advances the revision when state changes.
- [ ] Logout/re-login restores latest saved state.
- [ ] Account A and account B still have independent save slots.
- [ ] Optional: load the same account in profile A and B before either saves; save from A, then trigger a change/save from stale B. B should see the conflict status and **Load latest** action; it must not overwrite A's newer state.
- [ ] Select **Load latest** on B. B's local stale state is replaced by the latest server save, conflict clears, and future saves resume.

## Explicitly not implemented in this milestone

- [ ] Do not expect hacking an in-game server to change that server for another player yet.
- [ ] Do not expect First Bank/Crown Reserve balances or account activity to be shared between player accounts.
- [ ] Do not expect Warez, antivirus, popup, malware, installed software, files or website admin access to affect another player.
- [ ] Do not launch PvP/economy testing as if browser-side values were cheat-resistant.

## If something fails

Record the test case, expected result, actual behaviour, browser console/network error and the relevant Render log excerpt. Redact passwords, `DATABASE_URL`, `SESSION_SECRET`, cookies, session identifiers and all other secrets. Include test IDs when reporting issues (for example `MW-06`).
