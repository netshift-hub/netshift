# Uploading the NETSHIFT E2 source ZIP

This ZIP is a **complete candidate snapshot based on E1 plus E2**, not a patch. It intentionally excludes `.git`, `node_modules`, and real `.env` files while retaining `.env.example`.

1. Make a backup/temporary branch of your local `netshift-hub/netshift` checkout. Do not overwrite the `.git` directory.
2. Extract the full source ZIP into a temporary directory.
3. Merge/copy the extracted project-root files into your existing local repository; allow the E1/E2 versions of modified source files to replace their counterparts, but review all GitHub Desktop changes before proceeding. Do not copy `.env.example` over your own secret environment file (the ZIP does not contain a real `.env`).
4. Run `npm run check` from the repository root. It must pass before committing.
5. Verify the Render staging service's branch and database connection before pushing. The server installs the E1 schema at startup, but E2 does not run a destructive cleanup or reset the database.
6. Run `npm run test:economy:postgres` with a dedicated disposable database as described below; then perform the two-account staging checklist before making E2 available to players.

## PostgreSQL test safety

The integration script only reads `NETSHIFT_ECONOMY_TEST_DATABASE_URL`, never the application's `DATABASE_URL`. It requires:

- `NETSHIFT_ECONOMY_TEST_DB_ACK=I_CREATED_A_DISPOSABLE_DATABASE`
- For a remote test database, the database name must clearly identify it as test/disposable/staging/scratch/CI and `NETSHIFT_ECONOMY_ALLOW_REMOTE_TEST_DB=YES_I_CREATED_A_DISPOSABLE_POSTGRES_DATABASE` is also required.

Example PowerShell (replace with your own disposable test database):

```powershell
$env:NETSHIFT_ECONOMY_TEST_DATABASE_URL = "postgresql://USER:PASSWORD@localhost:5432/netshift_test"
$env:NETSHIFT_ECONOMY_TEST_DB_ACK = "I_CREATED_A_DISPOSABLE_DATABASE"
npm run test:economy:postgres
```

Do not use the staging/production application `DATABASE_URL` for this test. The script creates and later drops only a randomly named schema inside the database you explicitly designate as disposable. A `SKIP` result means integration tests have not passed.
