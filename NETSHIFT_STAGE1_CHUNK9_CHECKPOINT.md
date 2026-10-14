# NETSHIFT Stage 1 — Chunk 9 Checkpoint

**Status:** locally implemented; automated checks pass; owner review and staging validation pending. Not committed or deployed.

## Scope

Retire or fence legacy browser-side inventory mutation routes for signed-in accounts so canonical Core records are the only visible/usable player inventory authority.

## Changes

- Authenticated canonical inventory hydration now starts the file, filename-to-folder map, folder and Recycle Bin mirrors empty, then adds rows returned by the Core APIs. Installed/archive software mirrors are rebuilt only from canonical software rows.
- Authenticated Desktop, Explorer, Archive and Recycle Bin views hide local-only records that do not carry a canonical server record ID. Folder rendering also requires canonical folder IDs.
- The signed-in path now refuses old client-only software installation/run and legacy website/software download and software purchase flows. Supported shared-host claims continue through the existing server-side host inventory and atomic claim endpoints.
- Local file opening, context actions, drag/drop, restore, permanent delete and empty-Recycle-Bin paths are fenced. Canonical actions continue to use the owner-scoped file APIs; bulk delete skips folders because atomic folder subtree deletion is not implemented.
- Offline prototype behavior remains on the old local-only path when no NETSHIFT account is signed in.
- Added `scripts/check-stage1-legacy-inventory-fence.js` and wired it into `npm run check`. Updated the prior canonical inventory assertions to reflect the stricter authenticated policy.
- The cumulative working tree also includes the previously prepared host loot regeneration fix, its regression test, F4 checklist and docs, so that both changes can be applied as one patch to an unchanged `dev` checkout.

## Validation performed locally

- `npm run check` — passed all checks, including client JavaScript syntax, save protocol/cutover, hydration, canonical inventory, legacy inventory fence, loot regeneration, and atomic host-download claim tests.
- `git diff --check` passed against both prepared repository baselines; cumulative and Chunk 9-only patches apply cleanly in isolated copies. The full `npm run check` suite also passes after applying the cumulative patch to a clean baseline.

## Runtime validation still required

- Browser smoke test against the intended disposable staging deployment.
- Two-account isolation test with accounts A/B in separate browser profiles.
- PostgreSQL transaction, rollback, session-owner and host-claim concurrency tests.
- Verify unsupported legacy downloads/shop installs are clearly refused and no canonical records or server-backed balances change.
- Verify the deployed host stock regenerates within the intended 3-item website / 5-item workstation caps once the regeneration fix is deployed.

## Explicit exclusions

Chunk 9 is not a claim that banking/economy, hardware upgrades, all installed-software effects, malware/infection outcomes, NPC/security schedulers, PvP/hacking outcomes, logs or admin MFA are fully server-authoritative. Those remain subsequent state-ownership work. Stage 1 is not complete until Chunk 10 regression acceptance is reviewed with runtime evidence.
