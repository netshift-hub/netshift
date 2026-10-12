# NETSHIFT Online — hosted web-game starter

This project packages the existing NETSHIFT v21 game with a Node.js/Express backend, PostgreSQL-backed user accounts and sessions, and per-account cloud saves.

## Included in this milestone

- The existing v21 interface and game mechanics, retained in `public/index.html`.
- Username/password registration and sign-in. User passwords are hashed with bcrypt; raw passwords are not stored.
- Server-side sessions stored in PostgreSQL, with HttpOnly/SameSite cookies.
- Per-user JSON save slot stored in PostgreSQL and loaded after sign-in.
- Automatic saves roughly every four seconds when state changes, plus a manual **Save game** control.
- Login rate limits, request-size limits, parameterised SQL and a health-check endpoint.
- Render Blueprint configuration to create the web service. You supply the external PostgreSQL connection string.

## What this is not yet

This is a persistent account-based web version, not multiplayer. Each account has a private copy of the game's world. Most gameplay logic still executes in the browser and the server stores the browser-submitted save; a technically capable player can alter that save. Do not use this version for a competitive shared economy or real-money value. A later multiplayer milestone should move cash transfers, purchases, hacks, timers and security sweep outcomes into server-validated game commands.

The original prototype uses inline JavaScript handlers and styles, so the server currently disables Content Security Policy while retaining Helmet's other defaults. A stronger CSP is appropriate after the client is modularised. This first build has no email verification, password reset, account deletion or admin dashboard; keep a unique password and do not reuse a sensitive password.

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
5. Open the site in a second browser profile and log in to the same account. The saved game should load there too. Do not play the same account concurrently in both tabs yet; the last save wins.
6. Register a second test account and confirm it starts with a separate save.

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
- Each account is currently an isolated single-player sandbox. There is no cross-player visibility, shared economy, recovery email, admin moderation, or server-authoritative anti-cheat.
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
4. Move important game commands and economy logic to validated server endpoints.
5. Add an actual shared world (player profiles, public network state, PvP permissions, conflict resolution, anti-cheat and moderation).
