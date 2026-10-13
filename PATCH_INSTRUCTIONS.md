# Apply NETSHIFT host-loot regeneration fix

This patch was prepared against the current `dev` source files fetched from `netshift-hub/netshift`. It is not committed or deployed by this bundle.

## Files changed

- `server.js` — target type migration/seed metadata, target type in shared-world responses, transactional bounded regeneration ticker.
- `lib/host-download-claim.js` — use the shared authoritative stock-removal helper during claims.
- `lib/host-loot-regeneration.js` — new weighted loot-table and bounded-stock policy.
- `scripts/check-stage1-host-loot-regeneration.js` — new deterministic regression tests.
- `package.json` — add the new regression check to `npm run check`.
- `NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md` — add live staging acceptance steps.
- `CHANGELOG_V2.md` — document the prepared implementation and unverified runtime gates.
- `NETSHIFT_STAGE1_HOST_LOOT_REGENERATION_FOLLOWUP.md` — complete design and acceptance record.

## Apply through GitHub Desktop

1. Check out branch `dev` and pull the latest `origin/dev`.
2. Make sure your worktree is clean or back up any unrelated local changes.
3. Extract this ZIP into the repository root, preserving the folder paths and allowing only the listed files to be replaced/added.
4. Review the changed files. No `.env`, dependency lockfile, credentials, or database export is included.
5. Run `npm run check` and `git diff --check` from the repo root.
6. Commit and push to `origin/dev`. Render/Neon deployment and runtime testing are owner-managed; this bundle does not deploy anything.

Alternatively, from the repository root, run `git apply --check NETSHIFT_Host_Loot_Regeneration_Fix.patch` and then `git apply NETSHIFT_Host_Loot_Regeneration_Fix.patch` using the separate patch file.

## Expected behaviour after deployment

- WHOIS-listed website stock: maximum 3 entries.
- NPC workstation stock: maximum 5 entries.
- New stock: weighted server-side loot-table selection; software-level odds depend on firewall level. L1 remains the most common individual level, while L5 remains rare.
- When full, the oldest generated loot is replaced with a fresh unique item ID. Overfull legacy inventories are compacted during their next due regeneration.
- `target_type` is added as an idempotent schema migration and existing seeded targets are updated: the seeded `hacker` target is `npc_workstation`; other seeded shared targets are `website`.
- The previous credential-lockout gate and atomic download transaction remain in place.

## Remaining verification

Local automated checks pass. The patch does not establish live PostgreSQL locking, multi-instance behavior, or browser/UI behavior. After deployment to the disposable staging database, follow section F4 in `NETSHIFT_CORE_V2_STAGING_TEST_CHECKLIST.md`. Do not test against production.
