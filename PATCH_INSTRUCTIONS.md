# NETSHIFT startup/auth regression fix

Target: `netshift-hub/netshift`, branch `dev`

## Files in this bundle
- `public/index.html` — moves canonical inventory mirror declarations before the first desktop render, preventing a temporal-dead-zone `ReferenceError` during page startup.
- `scripts/check-core-files-ui.js` — adds regression guards for declaration order, single declarations, JSON POST auth submission, and login/register submit listeners.

## Apply with GitHub Desktop
1. Fetch origin and confirm you are on `dev`.
2. Back up your current `public/index.html` and `scripts/check-core-files-ui.js`.
3. Copy the two files from this bundle over those paths in your local repository.
4. Review the diff. Only those two files should change.
5. Run `npm run check` and `git diff --check` in the local repository.
6. Commit as `Fix startup inventory declaration ordering` and push to `origin/dev`.
7. Check Render's deployment logs. Once deployed, load the app cleanly and confirm the console no longer reports `NETSHIFT_CORE_FILES` before initialization. Test account creation/login in the browser and check Network shows POST requests to `/api/auth/register` and `/api/auth/login`, not URL query parameters.

No database data or Neon/Render environment settings are changed by this patch.
