# NETSHIFT E1 — Economy Ledger Foundation Checkpoint

## Scope delivered

- Added idempotent PostgreSQL schema installation for money transaction headers, signed money postings, canonical asset provenance, seller/merchant registry, and a per-website income summary view.
- Added double-entry validation in the JavaScript ledger helper and a deferred PostgreSQL constraint trigger that independently requires at least two postings totalling exactly zero cents at commit and rejects postings added in a later database transaction.
- Added idempotency keys plus request hashes for money transactions and asset events. A reused key with a different request payload is rejected. Added a locked-account opening-balance helper for future ledger-backed actions; it records a non-zero current balance without changing it, and avoids baselining zero balances or ledgers that already contain postings.
- Added database-level append-only triggers for transaction headers, postings, and asset provenance events.
- Registered the existing `hack3rw4re.net` and `computerstore.net` storefronts as separate website merchants with separate treasury system accounts, so later sales income is attributed per website rather than pooled.
- Added fast deterministic E1 contract tests to `npm run check` and an opt-in PostgreSQL integration suite.
- Documented the ledger model, website revenue model, retention behaviour, upload guidance and deferred scope.

## What E1 does not do

- It does not implement or enable player transfers, purchases, hardware upgrades, subscriptions, cashout, rewards, NPC loot, paid trades, or other economy action endpoints.
- It does not change current bank balances, automatically baseline any existing accounts at startup, transfer website funds, or assign website ownership. The opening-balance helper is only called by later money-changing actions after the database integration gate is passed.
- It does not count virtual shop clicks or purchase attempts as income. Website revenue remains zero until a later server-authoritative sale posts an actual balanced transaction to that website's treasury.
- It does not yet wire every canonical inventory action to asset provenance, and it does not make the hacking loop server-authoritative. Those are separate implementation slices.

## Validation results (2026-10-14)

- `npm run check`: **PASS**. All existing automated Stage 1 checks and E1 deterministic contracts passed.
- `node --check` for server and E1 JavaScript files: **PASS**.
- `npm run test:economy:postgres`: **SKIP**, because `NETSHIFT_ECONOMY_TEST_DATABASE_URL` was not set. No database connection was attempted.
- Real PostgreSQL constraints/rollback: **NOT RUN**.
- Live Neon/Render staging and two-account browser acceptance: **NOT RUN**.
- No live database has been altered and no accounts/balances have been deleted or changed.
- No GitHub commit, push, or Render deploy was performed.

## Next recommended chunk: E2

Only after E1 passes real PostgreSQL integration, implement First Bank player-to-player transfers through the ledger. Source debit, recipient credit, materialised balance updates, ledger postings and idempotency handling must share one transaction. Verify success, insufficient funds, rollback, retries and concurrent submissions using two disposable accounts.
