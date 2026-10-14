# NETSHIFT candidate source ZIP — GitHub Desktop upload guide

This archive contains the root NETSHIFT application source prepared with Stage 1 Chunks 9 and 10. It intentionally excludes `.git/`, local secrets, and `node_modules/`. It includes `.env.example`; do not replace it with a real `.env` file.

## Important: do not upload this ZIP file as the running application

GitHub and Render will not automatically unpack a ZIP committed to the repository. Extract the archive and use GitHub Desktop to commit the extracted source changes.

## Safe workflow

1. In GitHub Desktop, select the existing `netshift-hub/netshift` local repository and switch to the intended staging/development branch (`dev`, if that is still the current target). Click **Fetch origin**. Do not work on `main`.
2. Make a backup of the local repository folder or create a temporary branch before copying source files. Keep the existing repository's `.git/` directory intact.
3. Extract this ZIP to a temporary folder first and review this guide plus `NETSHIFT_STAGE1_CHUNK10_CHECKPOINT.md`. Then copy/merge the archive's files into the existing repository folder, allowing the included candidate files to overwrite their matching files. Do **not** copy a `.git/` directory from anywhere.
4. Before accepting the `public/index.html` overwrite, review the diff in GitHub Desktop. The prepared candidate was validated against a local baseline whose `public/index.html` blob differs from the subsequently fetched remote `dev` blob. If that file shows unrelated changes, stop and reconcile the file rather than overwriting them. Do not force or blindly commit a large replacement.
5. Run `npm run check` from the repository root. It should pass before you commit. Use GitHub Desktop's Changes tab to inspect the complete changed-file list and review the diffs.
6. Commit the changes with a message such as `Complete Stage 1 inventory fences and acceptance gate`, then push to the development/staging branch only after reviewing the exact branch and changed files.
7. Do not deploy or run integration tests against production. The opt-in PostgreSQL test needs a newly-created disposable database; see `scripts/test-stage1-postgres.js` and the Chunk 10 checkpoint.

## Validation and status

This candidate's local deterministic suite has been run. PostgreSQL integration tests and live browser/two-account staging tests have **not** been run. The archive is a complete source snapshot of the prepared candidate, not a claim that the current GitHub branch is already changed or that Stage 1 is signed off.
