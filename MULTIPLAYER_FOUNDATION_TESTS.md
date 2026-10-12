# NETSHIFT Online v1.3 — session ownership and multiplayer test checklist

Use **two different browser profiles or devices** for account A and account B. Use only fictional in-game values. Do not share passwords, cookies, session IDs, `DATABASE_URL`, or `SESSION_SECRET` in bug reports.

## 1. Deployment and persistence

- [ ] `/api/health` returns `ok: true`, `database: connected`, and `realtime: enabled`.
- [ ] Existing account and cloud-save data is still present after deploy.
- [ ] New database tables are created automatically on app start; no new environment variables are required.
- [ ] Save game succeeds and advances the revision; refresh/re-login restores the latest saved state.

## 2. One active account session

### No — keep the current session

- [ ] Sign in to account A in browser profile A and leave it connected.
- [ ] In profile B, try signing into the same account using the correct credentials.
- [ ] Profile B remains unauthenticated and shows a waiting message; it must not load account A's game before approval.
- [ ] Profile A receives a blocking, Windows 98-style dialog naming the requesting account session.
- [ ] The dialog cannot be dismissed by clicking outside it, pressing Escape, using browser Back, or activating gameplay shortcuts.
- [ ] Select **No** in profile A. The dialog closes, A remains signed in, and A can continue playing.
- [ ] Profile B receives the denial, returns to the sign-in form and does not gain access to the account save.

### Yes — relinquish access

- [ ] Repeat the second login attempt.
- [ ] In profile A, select **Yes**. The active session attempts a final cloud save before transferring ownership.
- [ ] A is signed out in all tabs that share that browser session; no old tab continues to have working save or multiplayer access.
- [ ] B proceeds into the game only after the server approves the handoff.
- [ ] B loads the latest cloud save. The latest changes made in A before pressing Yes should remain.
- [ ] Old A session requests to `/api/save` or `/api/world/summary` are rejected after handoff; old A cannot overwrite B's new save.
- [ ] B appears as the online operator after its Socket.IO connection is established.

### Edge cases

- [ ] Wrong password on profile B does not send a prompt to profile A.
- [ ] Two sign-in requests for the same account cannot create multiple active handoffs; a second request receives a clear conflict message.
- [ ] If the active session has no reachable socket but is still within the active lease, the second login is blocked with a recoverable message rather than silently taking over.
- [ ] If the requesting session cancels or its two-minute request expires, profile A remains owner; the modal stays blocking until A selects **No** to dismiss the expired request.
- [ ] After an expired request, a new login attempt can be made.
- [ ] Two tabs using the same browser cookie/session remain part of the same active session and do not repeatedly trigger handoff prompts.
- [ ] After the current session is inactive for five minutes and has no live socket, a fresh sign-in can recover the account; test this only with a disposable account because the session lease is intentionally timed.
- [ ] If the final save fails during handoff, Yes does not transfer ownership; the prompt explains the save issue and lets the owner retry or choose No.

## 3. Realtime presence and shared host activity

- [ ] Two different accounts can see each other in the World panel.
- [ ] Presence updates after sign-in/logout without a manual refresh.
- [ ] Probe a shared host as A; B sees the activity event and updated counter live.
- [ ] Shared probe state remains after refreshing either profile.
- [ ] Unauthenticated API requests to `/api/world/summary` and the shared probe route return 401.

## 4. Server-authoritative shared intrusion (v1.3)

- [ ] Refresh World panel and confirm each target shows its shared status, global probe count and the current player's own probe count.
- [ ] Attempt intrusion before probing a target. Server rejects it with `PROBE_REQUIRED`; no claim changes.
- [ ] Probe a host once; personal probe count increments and the Attempt intrusion button becomes available.
- [ ] Attempt intrusion. The server reports success/failure; the shared activity log records the attempt, and all connected clients receive the event.
- [ ] On success, both profiles show the same operator as controller; refresh both and confirm the claim persists.
- [ ] If another operator controls a host, the other player can probe then attempt a takeover; contested-host odds are lower than for an unclaimed host.
- [ ] Once a player controls a host, their own Attempt intrusion button is disabled and the API rejects repeat claims by that same player.
- [ ] After a **failed** attempt, immediately retry that same host from the same account; API rejects it with `BREACH_COOLDOWN` and `Retry-After`. If the first attempt succeeded, the server instead rejects a repeat claim because the player already controls the host.
- [ ] Attempt more than 12 intrusion requests per minute from the same IP; rate limiter eventually rejects requests. Do this only with a disposable test account and stop after confirmation.
- [ ] Try direct `POST /api/world/targets/:slug/breach` without authentication; expect 401.
- [ ] Confirm failure results do not change the host controller, but do appear in the persistent activity feed.
- [ ] Restart/redeploy, refresh World and confirm successful host claim and activity history remain.

## 5. Persistent operator chat

- [ ] Open World in A and B. Send a normal message from A.
- [ ] Both profiles show the message, username and timestamp without reloading.
- [ ] Refresh B; the message remains in the latest chat history.
- [ ] Send a message containing `<script>alert(1)</script>` as a text-safety test. The literal text may appear, but it must not execute as HTML or JavaScript.
- [ ] Empty messages are blocked at the client/server; messages longer than 300 characters are rejected by the server.
- [ ] Send more than five messages in a ten-second interval from one account. Further messages are temporarily rate-limited and not broadcast.
- [ ] A network disconnect shows an understandable offline/send error rather than claiming the message was saved.

## 6. Save revision and shared state

- [ ] Normal autosave/manual save still works.
- [ ] Account A and account B remain separate accounts with separate saves.
- [ ] Optional safeguard test: use the same account in two isolated profiles, let A obtain ownership, then confirm B is held at the handoff screen (normal path) rather than loading a concurrent game.
- [ ] If testing an old/stale browser session from before v1.2, confirm it cannot continue overwriting the account save after ownership migrates.

## 7. Explicit scope boundaries

The following are still **not** shared/authoritative in v1.3: fictional bank balances, software purchases/inventory, existing in-game website administrator sessions, server files, Warez, antivirus/security sweeps and malware outcomes. The World-panel host claim is a separate initial shared mechanic; it does not currently grant access to the existing site's admin backend. Do not test these as competitive multiplayer mechanics yet. The immediate next milestone is to wire the shared host-claim system into the existing site-admin flow and migrate software purchases/inventory to server-side transactional commands, then migrate bank transfers and malware/security outcomes.

## If a test fails

Record the test name, expected result, actual result, approximate time, browser console/network status and the relevant Render log lines. Redact secrets and cookies. Do not send a live session ID or real credentials.
