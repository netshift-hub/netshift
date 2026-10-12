## 1.3.0 — Server-authoritative shared host intrusion

- Added persistent per-operator probe progress for each shared target; an operator must probe a host at least once before attempting an intrusion.
- Added `POST /api/world/targets/:slug/breach`. The server checks account-session ownership, per-host cooldown, target security level, whether the host is already claimed, and generates the outcome server-side with a cryptographically secure random number.
- Added shared host claims/reclaims stored in PostgreSQL and broadcast to every connected operator. Failed and successful attempts are recorded in the shared activity log.
- Added rate limiting (12 intrusion requests per minute per client IP) and a 20-second per-player/per-target cooldown.
- Added a Windows 98-compatible `Attempt intrusion` action and host status display to the World panel.
- Added a pure server-owned rules module with automated checks for the difficulty curve and integration markers.
- This is the first authoritative shared hacking mechanic, but it is not yet tied to the local Password Cracker installation levels or existing website backend sessions. The latter migration is a subsequent step.

# Changelog

## 1.2.0 — Account session ownership and shared operator chat

- Enforced one active account owner session in PostgreSQL; the server refuses save and realtime access from a session that no longer owns the account.
- Added an approval-based sign-in handoff. A second correct login is held pending while the current session receives a blocking Windows 98-style Yes/No dialog. Yes saves and relinquishes access; No preserves access and rejects the request.
- Added session heartbeats, active-session reachability checks, a five-minute inactive-session lease and two-minute handoff expiry handling.
- Added cross-tab/session revocation signals and protected the handoff modal from dismissal via Escape, backdrop clicks or keyboard shortcuts.
- Added persistent, authenticated, rate-limited operator chat to the World panel. Messages are stored in PostgreSQL and broadcast to connected operators; rendered usernames/messages are escaped as text.
- Added additive database tables for session ownership, handoff requests and world chat; no new environment variables are required.
- Kept the v1.1 shared target registry, target probes, presence broadcasts and save revision conflict protection.
- Added automated static checks for session ownership and chat markers.
- Still not a complete shared hacking/economy simulation: purchases, target compromise, bank balances, files and malware outcomes require server-authoritative command migration.

## 1.1.0 — Multiplayer-compatible foundation

- Added authenticated Socket.IO connections sharing public operator presence in real time.
- Added a PostgreSQL-backed shared public-host registry and event feed.
- Added a server-authoritative, rate-limited `Probe host` action that atomically updates a shared target counter and writes a persistent event before broadcasting it to connected players.
- Added save revision checks to prevent stale concurrent sessions from silently overwriting a newer cloud save.
- Added a `Load latest` recovery control when a stale save is detected.
- Added syntax and multiplayer-marker checks to the Render build command.
- Kept in-game bank balances, target compromises, files, malware effects and most other existing game logic private/client-side; these are not yet shared or cheat-resistant.
