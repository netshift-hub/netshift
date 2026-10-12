# Changelog

## 1.1.0 — Multiplayer-compatible foundation

- Added authenticated Socket.IO connections sharing public operator presence in real time.
- Added a PostgreSQL-backed shared public-host registry and event feed.
- Added a server-authoritative, rate-limited `Probe host` action that atomically updates a shared target counter and writes a persistent event before broadcasting it to connected players.
- Added save revision checks to prevent stale concurrent sessions from silently overwriting a newer cloud save.
- Added a `Load latest` recovery control when a stale save is detected.
- Added syntax and multiplayer-marker checks to the Render build command.
- Kept in-game bank balances, target compromises, files, malware effects and most other existing game logic private/client-side; these are not yet shared or cheat-resistant.
