# NETSHIFT Core v2 preview changelog

## Added
- Authoritative player profile schema and stable simulated workstation IP assignment.
- Isolated First Bank player account records with bcrypt-hashed in-game bank passwords.
- Server-backed SafetyShield setting and one-hour cooldown API, plus Windows-style confirmation UI in My Computer.
- Player file/folder/text CRUD API with ownership checks and soft deletion.
- Shared-host stock records and atomic one-winner download claim endpoint preserving software family and level.
- Inventory refresh ticker foundation and credential lockout field.
- Admin roles, audit schema, bans, user listing and moderation endpoints; operator-only grant CLI.

## Explicitly not complete
- Full PvP resolution and post-hack immunity.
- Full UI migration to canonical server inventory/files/bank state.
- Complete NPC attack scheduler, exact loot snapshot regeneration and router logs.
- Administrator MFA enrollment/enforcement and production security sign-off.
- End-to-end PostgreSQL/staging testing.
