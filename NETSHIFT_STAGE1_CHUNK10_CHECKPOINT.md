# NETSHIFT Stage 1 Chunk 10 checkpoint — regression and acceptance gate

**Prepared:** 2026-10-14
**Branch target:** `dev`
**Status:** Local implementation prepared; not committed, pushed, deployed, or signed off.

## Scope delivered

1. Added `scripts/check-stage1-acceptance.js` as a final deterministic wiring/coverage audit, included in `npm run check`. It checks the presence and wiring of the existing Stage 1 contract/helper tests and verifies T1–T6 evidence is documented without pretending runtime tests passed.
2. Added `scripts/test-stage1-postgres.js` and `npm run test:stage1:postgres` for opt-in PostgreSQL transaction tests covering successful claim delivery, active filename uniqueness rollback, simultaneous duplicate claims, revoked session/non-controller denial and attempted reuse of a consumed ID.
3. The PostgreSQL script requires `NETSHIFT_STAGE1_TEST_DATABASE_URL` and `NETSHIFT_STAGE1_TEST_DB_ACK=I_CREATED_A_DISPOSABLE_DATABASE`. It never falls back to `DATABASE_URL`, refuses Render hosts and main/live/production identities, requires a remote database name to include `test`, `disposable`, `stage`/`staging`, `scratch`, or `ci`, and blocks remote DB URLs unless `NETSHIFT_STAGE1_ALLOW_REMOTE_TEST_DB=YES_I_CREATED_A_DISPOSABLE_POSTGRES_DATABASE` is also set. It creates a randomly named schema, creates its fixture tables inside it, then drops only that schema.
4. Expanded `NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md` with the T1–T6 matrix, two-account browser protocol and evidence template. Expanded `NETSHIFT_STATE_OWNERSHIP_AUDIT.md` with the test-to-ownership mapping and explicit limitations. Updated the plan/changelog to retain the pending gate.
5. The cumulative patch includes the still-unmerged Chunk 9 inventory writer fence, since `dev` baseline did not contain that fence at preparation time. Host-loot regeneration is already part of the checked baseline.

## T1–T6 acceptance design

- **T1:** schema-v1 cutover, save allowlist, protected canonical-table preservation.
- **T2:** identity/session ownership, fail-closed hydration and stale-session fencing.
- **T3:** canonical file/folder/software views and signed-in legacy writer fence.
- **T4:** atomic host stock/claim/file delivery, rollback, concurrency, bounded loot regeneration.
- **T5:** cross-account privacy, host-controller checks and explicit deferred security boundaries.
- **T6:** reproducible evidence and owner-controlled release sign-off.

## Validation status

- [x] `npm run check` on the cumulative working tree — PASS (2026-10-14, Node.js 22.16.0).
- [x] `git diff --check` — PASS (2026-10-14).
- [x] Bundle integrity and patch-application checks — PASS against the committed local baseline and the prepared Chunk 9 snapshot. The current remote `public/index.html` blob differs from the local base snapshot, so run `git apply --check` against your current checkout before applying; do not force conflicts.
- [ ] PostgreSQL integration — **NOT RUN**; no disposable database URL was supplied for this run.
- [ ] Browser/two-account staging checks — **NOT RUN**.
- [ ] GitHub commit/push/deployment — not performed; project owner controls these actions.

## Safety and limitations

The opt-in PostgreSQL test validates the real `claimHostDownload` SQL/transaction path against isolated fixture tables; it is not a full application-schema migration test and does not validate Render's multi-instance behaviour. The in-memory adapters remain valuable but are not PostgreSQL evidence. Stage 1 remains incomplete until T1–T6 have evidence, all required runtime checks pass, and the owner reviews/signs off.

Deferred systems remain outside the Stage 1 claim: banking transfers/economy ledger, complete PvP/hacking outcomes, NPC attack/security sweep scheduling, full software gifting/effects, email/password-reset workflows, enforced administrator MFA, and multi-instance Render cross-instance behaviour.
