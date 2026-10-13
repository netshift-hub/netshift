# NETSHIFT Core v2 Preview — Staging Deployment

## Scope and safety

This is a **staging-only implementation preview**, not a public/production release. It preserves the existing v1.3 foundation and adds initial server-side player profiles, SafetyShield, First Bank account setup, persistent file APIs, shared-host download claims, and administrative foundations. PvP resolution, full NPC attacks, complete gameplay/UI migration, administrator MFA, and other items listed in `README_V2_STATUS.md` remain unfinished.

Do not merge this preview into `main`. Do not grant administrator access on staging until MFA and moderation enforcement are completed. Ensure Render's `netshift-staging` service uses the **staging Neon database**, never the production connection string.

## Deploy through GitHub Desktop (Windows)

1. Download and extract this bundle to a temporary folder.
2. Open GitHub Desktop and select the `netshift` repository.
3. Select the `dev-multiplayer-v2` branch. Verify the current branch label before copying any files.
4. Choose **Repository → Show in Explorer** to open the local repository folder.
5. Copy the extracted bundle's contents into the repository root and allow matching files to be replaced. Copy the `public` and `scripts` folders as folders. Do not copy any real `.env` file. Keep any existing `package-lock.json`; Render's configured `npm install` command can reconcile it with `package.json`.
6. Review GitHub Desktop's changed-file list. It should show application/source/docs changes only; it must not show `.env` or `node_modules`.
7. Commit as `Add NETSHIFT identity and SafetyShield polish`, then click **Push origin**.
8. In Render, confirm `netshift-staging` is connected to `dev-multiplayer-v2` and automatic deploys are enabled. Watch the build and deploy logs. The build should execute `npm install && npm run check`.
9. Open `https://netshift-staging.onrender.com/api/health`. `ok: true`, `database: connected`, and `realtime: enabled` confirms basic application/database connectivity, not gameplay correctness.

This bundle now also includes `lib/game-identities.js`, `scripts/check-game-identities.js`, `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` and `NETSHIFT_V2_IMPLEMENTATION_PLAN.md`. Those files should appear in the changed-file list.

The identity migration is intentionally limited: on each player's next profile load, a legacy predictable `10.x.x.x` address is replaced once, and a recognisable non-eight-digit legacy player bank number is replaced once. Current eight-digit bank numbers are preserved. This does not modify balances or bank password hashes. Still, deploy to staging first and confirm existing accounts remain usable and identities remain stable across refreshes.

If GitHub Desktop reports a large or unexpected set of changes, stop before committing and review the list. Never switch to `main` for this deployment.

## Environment variables

Configure these in the Render service's **Environment Variables** section, not **Secret Files**:

- `DATABASE_URL`: pooled PostgreSQL connection string for the staging Neon project.
- `SESSION_SECRET`: a fresh, random 32-byte-or-stronger secret unique to staging.
- `NODE_ENV=production` (Render usually supplies this for Node services; set it explicitly if needed).
- `PG_POOL_MAX=5` is optional; the server defaults to 5.

Do not put credentials in GitHub, this bundle, or chat. The `.gitignore` excludes `.env` and `.env.*` while keeping `.env.example` trackable.

## Rollback

If deployment fails, use Render's deployment history to redeploy the last known-good v1.3 deployment. Alternatively, revert the v2 commit on `dev-multiplayer-v2` and push the revert. Do not revert or redeploy `main` as part of staging recovery.
