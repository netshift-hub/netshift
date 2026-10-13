# NETSHIFT Stage 1 — Host loot regeneration follow-up

**Status:** Prepared locally; awaiting commit/deploy and live staging acceptance.
**Scope:** Bounded shared-host inventory regeneration and server-owned weighted loot selection. Does not implement NPC attacks or security-sweep gameplay by itself.

## Design decisions

- Persist each target's kind as `website` or `npc_workstation`. Seeded WHOIS-listed websites use `website`; the seeded Forgetful Hacker target uses `npc_workstation`. New NPC workstation creators must set this field explicitly.
- Stock limits count both static and generated host items: websites have a maximum of 3; NPC workstations have a maximum of 5.
- Under-cap inventory receives a loot-table spawn. At capacity, the oldest generated item is removed and replaced. Static site content is preserved. Over-cap legacy arrays are compacted to the capacity first, retaining static content and the newest generated entries, then replacing the oldest retained generated item with a fresh spawn.
- Generated entries have a fresh per-spawn ID, `generated: true`, and an ISO `generatedAt` timestamp. Old `${slug}-warez1[-<epoch-bucket>]` entries are recognised during recovery so the previously accumulated Warez pile can be pruned on its next due regeneration.
- The generator runs only when the persisted `next_regen_at` is due and the existing `credential_lock_until` is absent/expired. The regeneration uses row-level locking with `SKIP LOCKED`; claims and regeneration update canonical stock and its version.
- A full stock made entirely of non-generated static content is not silently deleted to make room. It is left intact, logs a warning, and is reconsidered at the next scheduled cycle.

## Software-level weighting

Weights are percentages by target firewall/security level. Each row's values correspond to software levels L1 through L5, sum to 100, and are applied after the software-vs-text-file roll:

| Firewall level | L1 | L2 | L3 | L4 | L5 |
|---:|---:|---:|---:|---:|---:|
| 0 | 96% | 4% | 0% | 0% | 0% |
| 1 | 86% | 12% | 2% | 0% | 0% |
| 2 | 72% | 19% | 7% | 2% | 0% |
| 3 | 60% | 23% | 11% | 5% | 1% |
| 4 | 50% | 24% | 15% | 8% | 3% |
| 5 | 40% | 26% | 18% | 11% | 5% |

L1 is the most common individual level at every firewall value; L5 remains uncommon but is more likely on stronger targets. Software family has its own weighted table: `crc` 18, `wwl` 15, `warez` 14, `fc` 10, `uploader` 11, `av` 13, `extractor` 6, `embedder` 6, `popup` 7. Twelve percent of generated drops are files selected from a separate weighted text-loot table; the rest are software. Generated text loot contains fictional descriptive information, not credentials.

## Authoritative removal contract

A claim removes its selected item from `netshift_world_host_inventory.stock` in the same transaction that inserts the claim ledger row and canonical `/downloads` record. The shared pure `removeHostStockItem` helper is used for this path. Future player/system removal actions (including planned NPC interactions and security sweeps) must:

1. lock the current host-inventory row in a transaction;
2. remove the exact authoritative item ID through the shared stock-removal helper;
3. persist the changed stock and increment `inventory_version` atomically;
4. broadcast or refresh the host view so clients stop showing the removed item;
5. never reintroduce a consumed/removed ID as a fresh drop.

Removing a player's downloaded copy is a separate operation and must not remove host stock unless an explicit game action also does so.

## Validation

Local automated tests cover limits, firewall-weighted level selection, family/file loot tables, unique spawn metadata, legacy over-cap compaction, oldest-generated replacement, stock-removal helper behaviour and static wiring into the server ticker. `npm run check` passes locally.

Still required on disposable staging:

- Existing overfull website inventory compacts to 3 on its next due regeneration; NPC workstation inventory caps at 5.
- Multiple regeneration cycles keep counts at/below their caps and rotate oldest generated items with fresh IDs.
- Higher-firewall targets show a higher rate of L2–L5 drops across a meaningful sample; the currently seeded shared-host registry tops out at firewall level 4, so level-5 behaviour is currently covered only by deterministic automated tests until a level-5 shared target exists.
- Claims, inventory-version updates, unique claim records, duplicate protection and the three-day credential lockout remain correct against PostgreSQL.
- PostgreSQL transaction locking and multiple Render instances have not yet been validated live.
