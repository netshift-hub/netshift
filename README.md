# NETSHIFT Online — multiplayer foundation and shared intrusion (v1.3)

This project packages the existing NETSHIFT v21 game with a Node.js/Express backend, PostgreSQL-backed user accounts and sessions, and per-account cloud saves.

## Included in this milestone

- The existing v21 interface and game mechanics, retained in `public/index.html`.
- A PostgreSQL-enforced single active account-owner session. When the same account signs in elsewhere, the active session receives a mandatory Windows 98-style Yes/No handoff prompt; the requesting session remains unauthenticated until Yes is approved.
- Session heartbeat and inactive-session lease; expired/cancelled handoff requests cannot take account ownership.
- An authenticated Socket.IO channel sharing online operator presence and persistent operator chat in real time.
- A shared public-host registry seeded from the current game target catalogue.
- A **World** panel in the account toolbar showing online operators, public targets and recent shared activity.
- A server-validated `Probe host` action that increments a global target counter and per-operator probe progress, writes a persistent event in PostgreSQL and broadcasts it to other connected players.
- A server-authoritative `Attempt intrusion` action: an operator must probe the host first; host security level and whether another operator controls the host affect the chance; the server rolls the outcome, persists the claim/reclaim or failure, enforces a cooldown and rate limit, and broadcasts the result.
- Shared operator chat persists in PostgreSQL, broadcasts through Socket.IO, escapes messages when rendering, limits messages to 300 characters and enforces a per-account rate limit.
- Shared target/probe/event/chat state persists across web-service restarts; presence is recalculated on reconnect.
- Optimistic save revisions: two concurrent sessions can no longer silently overwrite each other's cloud save. A stale session is shown a **Load latest** recovery control.
- Username/password registration and sign-in. User passwords are hashed with bcrypt; raw passwords are not stored.
- Server-side sessions stored in PostgreSQL, with HttpOnly/SameSite cookies.
- Per-user JSON save slot stored in PostgreSQL and loaded after sign-in.
- Automatic saves roughly every four seconds when state changes, plus a manual **Save game** control.
- Login rate limits, request-size limits, parameterised SQL and a health-check endpoint.
- Render Blueprint configuration to create the web service. You supply the external PostgreSQL connection string.
- Additive database migrations for account ownership, login handoffs, chat and per-operator target progress, plus host-claim columns. No new environment variables are required.

## What this is not yet

This is an **initial multiplayer-compatible foundation**, not a complete multiplayer game. The shared slice currently covers authenticated presence, public target metadata, server-recorded probe events, operator chat, and a first server-authoritative shared host compromise/claim mechanic. The rest of the game remains each player's private sandbox. Most existing gameplay logic still executes in the browser and the server stores the browser-submitted save; a technically capable player can alter that save. Bank balances, purchases/inventory, in-game website administrator sessions, file state, malware and security-sweep outcomes are **not** yet shared or server-authoritative. The shared host intrusion action is currently a standalone World-panel mechanic and is not yet wired to installed Password Cracker levels or the existing local admin-login flow. Do not use this version for a competitive shared economy or real-money value. The next gameplay migrations must move cash transfers, purchases, hacks, timers and security-sweep outcomes into validated transactional server commands.

The original prototype uses inline JavaScript handlers and styles, so the server currently disables Content Security Policy while retaining Helmet's other defaults. A stronger CSP is appropriate after the client is modularised. The first shared-world deployment is intended to run as one Render web-service instance. The default Socket.IO adapter keeps live presence/broadcasts within that instance; before running multiple service instances, configure a shared Socket.IO adapter and suitable session affinity/sticky sessions. This first build has no email verification, password reset, account deletion or admin dashboard; keep a unique password and do not reuse a sensitive password.

## Deploy online (recommended path)

The prepared deployment uses **Render for the web service** and **Neon or another managed PostgreSQL provider for the database**. This avoids relying on a local disk for player data. Render's own free PostgreSQL plan currently expires after 30 days, so do not use that plan for lasting player saves unless you upgrade it. Check both providers' current limits and terms before launching publicly.

### 1. Create a database

1. Create a PostgreSQL project with your chosen managed database provider, for example [Neon](https://neon.tech/).
2. Create or select a database and copy its **pooled PostgreSQL connection string** if the provider offers one.
3. Keep the connection string private. Do not paste it into this chat or commit it to GitHub.

The connection string should include the provider's required TLS/SSL parameter, often `sslmode=require`.

### 2. Put the project in your GitHub repository

1. Download and unzip the project package.
2. Create a **private** GitHub repository named `netshift-online` (recommended while the project is still being developed).
3. Upload the files and folders inside the unzipped `netshift-online` folder to the repository root. The root should contain `package.json`, `server.js`, `render.yaml`, and `public/index.html`.
4. Do not upload a `.env` file or any real secrets. `.gitignore` already excludes `.env` and `node_modules`.

### 3. Deploy with Render Blueprint

1. Sign in to [Render](https://render.com/), choose **New → Blueprint**, and connect your GitHub repository.
2. Render reads `render.yaml` and proposes a web service. During setup, provide `DATABASE_URL` with the private connection string from your database provider. Render will generate `SESSION_SECRET` for you.
3. Start the deploy. The first start creates the required tables automatically.
4. When the service is live, open the generated `https://…onrender.com` URL. Visit `/api/health` to confirm the app and database are connected.

Render's free web services may spin down when idle, so the first visit after a period of inactivity may be slow. The PostgreSQL database is separate and holds your saves. Provider plan limits can change; review them before sharing broadly.

### 4. Smoke-test accounts and persistence

1. Register a test account with a unique password of at least 12 characters.
2. Confirm the game opens and the account name appears in the NETSHIFT ID toolbar.
3. Make a small in-game change and use **Save game**. Confirm a saved time appears.
4. Log out, sign back in and confirm the progress returns.
5. Open the site in a second browser profile and try to sign into the same account. The active profile must show the blocking Yes/No handoff dialog. Choose No to keep the current profile signed in, then repeat and choose Yes to verify the previous session is signed out and the new one loads the latest save.
6. Register a second test account and confirm it starts with a separate save. Sign into both accounts and test realtime presence, target probes and shared chat through the World panel.

## Run locally (requires Node.js 20+ and PostgreSQL)

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and a random `SESSION_SECRET` of at least 32 characters.
3. Run:

```bash
npm install
npm run check
npm start
```

4. Open `http://localhost:3000`.

## Save behaviour and limitations

- Save data is associated with the authenticated account ID, not the submitted username.
- The game auto-saves when its serialised state changes (approximately every four seconds); manual save is also available.
- Browser-tab HTML snapshots are intentionally not stored; after a reload the game navigates to the saved address and requires fresh in-game administrator/bank sign-ins.
- App-window geometry and live timers are not guaranteed to resume exactly where they left off; deadline/subscription timestamps already stored in game state may continue to age while logged out.
- Account ownership is now exclusive to one active browser session (multiple tabs sharing the same browser cookie belong to that one session). The signed-in session must approve an explicit handoff to another browser/device. A disconnected, unreachable active session blocks takeover until it reconnects or its five-minute inactivity lease expires.
- Each account's existing game progression is still a private sandbox. Shared presence, host probes, operator chat, and the separate World-panel host-claim mechanic are available, but there is no shared bank/economy, integration with the existing site-admin hacking flow, shared file state, malware effect, or server-authoritative anti-cheat. Recovery email, password reset, account deletion, and moderation tools are also not included.
- Back up PostgreSQL before public testing and before changing save schema.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Secret used to sign sessions; at least 32 characters |
| `NODE_ENV` | Recommended in production | Set to `production` on hosting |
| `PORT` | No | HTTP port; hosting providers generally supply this |
| `DATABASE_SSL` | No | Set `true` only if TLS is required and not expressed in the URL |
| `PG_POOL_MAX` | No | PostgreSQL pool size (defaults to 5) |

## Next engineering milestones

1. Test and fix account/save behaviour with real browser sessions.
2. Add save migration/version handling and a backup/restore procedure.
3. Modularise the client and establish regression tests for existing mechanics.
4. **v1.1 slice:** authenticated online presence, persistent shared targets and server-recorded live probe feed; save concurrency control.
5. **v1.2 slice:** exclusive account session ownership, explicit handoff approval, persistent realtime operator chat and stale-session enforcement.
6. **Current v1.3 slice:** server-authoritative World-panel target intrusion/claim/reclaim with player-specific probe prerequisite, cooldown, rate limit and persistent activity records.
7. Migrate installed software/purchases and the existing website admin-login flow to server-validated commands; decide how local cracker levels map to shared intrusions.
8. Migrate bank transfers, target files, malware and timer/security-sweep outcomes into atomic server-authoritative state changes.
9. Design PvP permissions, retaliation, offline protection, moderation, reporting and anti-cheat before enabling consequential player-vs-player effects.
10. Add integration tests using two accounts and a PostgreSQL test database before considering multiplayer beta.


## v1.3 deployment notes

No new production secret or environment variable is required for v1.3. The new ownership/handoff/chat tables and v1.3 host-claim/progress fields are created during startup. Existing account and save tables are preserved. The existing `DATABASE_URL` and `SESSION_SECRET` remain in use. The application creates the additional world, account-ownership, handoff, chat and per-operator target-progress tables automatically during startup; it also adds save revision and host-claim columns if missing. Existing user accounts and saves are preserved. After deploying, all existing open sessions will reconnect through the new version. The first legacy session to hit `/api/auth/me` claims ownership; if the same account was already open in multiple independent browser profiles, only the profile that claims the lock remains signed in, and the others must sign in again and request an explicit handoff.

### Multiplayer smoke test

1. Deploy v1.2 and confirm `/api/health` reports `database: connected` and `realtime: enabled`.
2. Sign in with two different accounts in separate browser profiles.
3. Click **World** in both toolbars. Both should list both operators and show a connected realtime link.
4. In profile A, choose a shared host and click **Probe host**. Profile B should receive the activity event without refreshing; the probe counter and last-prober name should update.
5. Refresh the page in profile B. The probe count and activity event should remain because they are stored in PostgreSQL.
6. Log profile B out. Profile A should see its presence disappear shortly after the WebSocket disconnect.
7. Try to sign into the same account from profile B while A is active. Profile A must receive the blocking Windows 98-style popup. Choose No and confirm A remains active and B is denied; repeat and choose Yes to confirm A is signed out, B is signed in and progress is preserved.
8. In the World panel, send a chat message from A and confirm B sees it live and after refresh. Check message length and rate limiting.
9. Probe a target, then use Attempt intrusion. It should generate a server-determined success/failure. A success makes the host show you as controller to both clients; a rival can attempt to seize it after probing, but has a lower chance. Expect a 20-second per-target cooldown.
10. Confirm the same in-game bank/economy, local admin sessions and malware effects are not shared yet; that is an explicit v1.3 limitation, not a failed test.

### New server API

- `GET /api/world/summary` (authenticated): online users, seeded hosts and the latest 30 shared events.
- `POST /api/world/targets/:slug/probe` (authenticated, rate-limited): writes a global probe count plus per-operator probe progress and broadcasts the event through Socket.IO.
- `POST /api/world/targets/:slug/breach` (authenticated, rate-limited): requires a personal probe, enforces a 20-second per-target cooldown, calculates odds on the server, resolves a cryptographically secure random outcome and persists/broadcasts claims or failed attempts.
- Socket.IO events: `world:presence`, `world:event`, `world:target-updated` and `world:chat-message`. Socket connections require the current account-owner Express session.
- Handoff endpoints: `/api/auth/handoff/:id`, `/api/auth/handoff/:id/respond`, `/api/auth/handoff/:id/complete`, and `/api/auth/handoff/:id/cancel`. The requesting session is not authenticated until the active owner approves.
- Chat event: `world:chat-send`, rate-limited per account, persisted and broadcast to the shared lobby.

The shared-world event stream exposes usernames and simulated actions only; it does not expose session IDs, emails, real IP addresses or private game saves. The `chancePercent` returned by a breach response is informational; the client cannot submit its own result or success roll.


## Economy E1/E2 implementation status

The current local candidate includes the E1 accounting journal and E2 First Bank transfer service. Transfers require a setup First Bank account and authenticated bank session, write balanced integer-cent postings, update both balances within one PostgreSQL transaction, and support idempotent retries. The UI also displays per-account transfer history. This is not yet staging-verified: run `npm run check`, then `npm run test:economy:postgres` using a separate disposable test database, and perform the two-account staging checklist before enabling wider economy play. Paid software purchases, website sales, upgrades, player rewards and Warez cashout remain later chunks and must not be treated as ledger-backed until implemented.
