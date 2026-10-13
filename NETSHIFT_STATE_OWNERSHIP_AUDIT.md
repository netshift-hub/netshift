# NETSHIFT Core v2 — State Ownership Audit (working document)

**Purpose:** make it explicit which layer is authoritative for each gameplay property before adding more multiplayer features. This is the first static inventory, not a claim that every browser-state call site has already been exhaustively migrated. The full audit is a release gate.

## Rules of ownership

1. PostgreSQL is the authority for persistent identity, money, account credentials, files, software ownership, PvP/NPC outcomes, host stock/claims, router/admin logs, sanctions and leaderboard submissions.
2. The browser may render, animate, collect proposed user input and cache read-only results. It may not decide a successful hack, credit/debit, ownership transfer, ban, cooldown or loot outcome.
3. Every mutation must authenticate the session, check session ownership and target ownership/permissions, validate the request, and apply state changes transactionally where related records must stay consistent.
4. API responses should expose only fields that the current player or public world is allowed to see. Never return password hashes, TOTP secrets, player bank-account secrets, private admin logs or another player's private inventory.
5. Every migration must be additive/idempotent, safe on redeploy, and independently testable against staging. No release step wipes staging or production data.

## Initial inventory from the current preview

| State family | Current observed location | Current authority status | Intended canonical source |
|---|---|---|---|
| NETSHIFT login/password hash | `netshift_users`, login APIs | Server-authoritative | PostgreSQL; preserve existing password hashes |
| Express login/session ownership/handoffs | `netshift_sessions`, `netshift_account_ownership`, handoff table | Server-authoritative in current architecture | PostgreSQL session store and ownership tables |
| Player simulated IP | `netshift_player_world`; displayed through client `PLAYER_IP` | Server-authoritative source, but some UI paths previously used a hard-coded display value | `netshift_player_world.workstation_ip`; client only displays profile value |
| SafetyShield and PvP immunity timestamp | `netshift_player_world` | SafetyShield setting/cooldown persisted; actual PvP resolution remains incomplete | `netshift_player_world` plus authoritative attack service |
| First Bank account number, credentials hash, initial balance | `netshift_bank_accounts` | Server-authoritative for First Bank profile and login; ledger/transfers/economy integration unfinished | Bank account + immutable transaction ledger |
| Player balance used by legacy gameplay | `state.accounts.player.balance` and nested client save payload | **Browser-authoritative in legacy systems**; not yet safely linked to bank ledger | Server-side wallet/account ledger and validated read APIs |
| NPC/demo account records and fake credentials | Browser `state.accounts` and legacy bank screens | Client/demo state; must not be treated as real player banking | Server-seeded NPC loot fixtures, strictly separate from player bank accounts |
| General save blob | `netshift_saves.save_data` / `netshiftSnapshot()` | Persisted by server but currently submitted from browser; protected fields need allowlisting and migration out of the opaque blob | Versioned player progression document for cosmetic/tutorial-only state; protected fields in dedicated tables |
| Player files/folders/text content | `netshift_player_files` and `/api/core/files` | API-backed CRUD with ownership checks; old desktop workflows still use local state | Canonical files service; browser Explorer/desktop as a view |
| Desktop-created files and folders | `state.localFiles`, `state.userFoldersV2`, `state.localFileFolders` | Browser-local; not yet integrated with Core file API | `netshift_player_files` with `parent_path`, type, content and owner |
| Downloaded software/files | Core download claim writes `netshift_player_files`; legacy handlers also modify `state.owned`, download queues and host files | **Split authority**; a successful API download may not render in the desktop | Canonical inventory/software item table and shared inventory service |
| Host stock and claim winner | `netshift_world_host_inventory`, `netshift_world_loot_claims` | Claim API is atomic for the tested endpoint; regeneration logic is only a foundation | Per-host stock snapshot/version, claim ledger and restart-safe regeneration service |
| Host compromise/probe history | `netshift_world_targets`, per-player progress, world events | Server-authoritative for Core endpoints; legacy hacking paths still exist | One server-side hack/host service consumed by old/new UI |
| CPU, connection level, firewall level, antivirus | Legacy `state.cpu`, `state.connection`, `state.firewall`, `state.antimalware` and save payload | Browser-authoritative in older mechanics | Player progression/loadout records, with server-validated upgrade/installation APIs |
| Hack success/access/crack state | Client `state.cracked`, `state.access`, `state.bypassed`, `state.server` and older hack functions; partial Core breach route | Mixed; Core probe/breach is persisted but does not replace all legacy outcomes | Authoritative attack service and persisted target/player records |
| Router and workstation access logs | Client `state.logs`, `state.localLog` and local edit functions | Browser-local; not suitable for shared PC intrusion gameplay | Target-scoped server access-log table with deletion/correlation rules |
| Bank credential loot, account money yielded by loot | Legacy client NPC accounts plus `credential_lock_until` foundation | Not complete; must never expose or mutate real player bank account records | Separate NPC credential/loot records and server-side 30-minute restock schedule |
| NPC attack timing/behaviour/inventory | Client game loop; no complete server scheduler yet | Browser-based/incomplete | Server scheduler and NPC workstation/inventory/log records |
| Popup spam and antivirus opportunity | Client UI/game tick | Client presentation; must be triggered by a server-confirmed infection status | Server-owned infection state + client-side retro UI effects |
| Online presence and live events | In-memory `onlinePlayers`, Socket.IO; some persistent event/chat tables | Works on the current single Render instance; in-memory state isn't cluster-shared | PostgreSQL for durable facts; shared Socket.IO adapter when scaling beyond one instance |
| Admin roles, ban records and admin audit | `netshift_admin_roles`, `netshift_user_bans`, `netshift_admin_audit` | Server-side role checks exist; MFA enforcement/socket revocation are incomplete | Server-side RBAC + mandatory TOTP step-up + audit events |
| Hall of Fame submission/score | Not implemented | Not implemented | Explicit opt-in submission table; server-derived score; public pseudonym separate from login identity |
| Desktop icon/window layout, browser tabs and transient animation | Client DOM and UI state | Client-only is acceptable for transient/cosmetic state; persistence requirements need selection | Keep client-side unless user value requires cross-session persistence; layout persistence can be a separately authorised profile setting |

## Required audit output before calling migration complete

For **every** persisted state property and every mutation function in `public/index.html` and `server.js`, extend the inventory with:

- source file/function and every read/write call site;
- whether the value is gameplay-authoritative, presentation-only, or derived;
- owner and permissions;
- current persistence layer and proposed canonical table/service/API;
- migration/backfill and compatibility plan;
- transaction/concurrency constraints;
- API response visibility rules;
- automated and two-account browser tests;
- status (`not audited`, `audited`, `migrating`, `server-authoritative`, `retired`).

Use searches for `state.`, `localStorage`, `sessionStorage`, `netshiftSnapshot`, `netshiftRestoreSave`, download completion functions, `bank`, `balance`, `owned`, `files`, `logs`, `firewall`, `waterwall`, `access`, and duplicate function declarations. The current page includes legacy overlapping implementations; migration must identify the active final binding as well as older definitions so they cannot silently restore client-only behavior.

## Explicit release blockers

- A malicious client must not be able to set their balance or inventory in `/api/save`.
- No legacy purchase, transfer, cashout or upgrade may claim to debit/credit real money until wired to the authoritative server ledger.
- No attack result may be accepted from client state alone.
- Player A's private bank records and non-public files must not appear to player B.
- Admin routes must require a valid admin role and verified MFA, not merely a role row.
- A multiple-instance Render deployment is not supported until cross-instance live events/session behaviour are configured and tested.
