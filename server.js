// NETSHIFT Online backend — user accounts, PostgreSQL sessions and per-user save slots.
require('dotenv').config();
const express = require('express');
const http = require('node:http');
const { Server: SocketIOServer } = require('socket.io');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('node:path');
const crypto = require('node:crypto');
const { worldBreachChance } = require('./lib/world-rules');

const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_LEASE_MS = 5 * 60 * 1000; // Treat a session as inactive after five minutes without a heartbeat.
const SESSION_HEARTBEAT_INTERVAL_MS = 25 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET is required and must be at least 32 characters.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Add a PostgreSQL connection string to .env.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  // Providers such as Neon include sslmode=require in their connection strings.
  // Set DATABASE_SSL=true only when your provider requires TLS but omits sslmode.
  ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
});
pool.on('error', error => console.error('Unexpected idle PostgreSQL client error:', error.message));

async function initialiseDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS netshift_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS netshift_saves (
      user_id BIGINT PRIMARY KEY REFERENCES netshift_users(id) ON DELETE CASCADE,
      save_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS netshift_sessions (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT netshift_sessions_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS netshift_sessions_expire_idx ON netshift_sessions (expire);

    ALTER TABLE netshift_saves
      ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE IF NOT EXISTS netshift_world_targets (
      slug VARCHAR(40) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      domain VARCHAR(120) NOT NULL UNIQUE,
      security_level SMALLINT NOT NULL DEFAULT 0 CHECK (security_level BETWEEN 0 AND 5),
      description VARCHAR(240) NOT NULL DEFAULT '',
      probe_count BIGINT NOT NULL DEFAULT 0,
      last_probed_by_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      last_probed_by_username VARCHAR(20),
      last_probed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE netshift_world_targets
      ADD COLUMN IF NOT EXISTS compromised_by_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS compromised_by_username VARCHAR(20),
      ADD COLUMN IF NOT EXISTS compromised_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS netshift_world_player_target_progress (
      user_id BIGINT NOT NULL REFERENCES netshift_users(id) ON DELETE CASCADE,
      target_slug VARCHAR(40) NOT NULL REFERENCES netshift_world_targets(slug) ON DELETE CASCADE,
      probe_count INTEGER NOT NULL DEFAULT 0 CHECK (probe_count >= 0),
      last_probed_at TIMESTAMPTZ,
      last_attack_at TIMESTAMPTZ,
      last_attack_result VARCHAR(16),
      PRIMARY KEY (user_id, target_slug)
    );
    CREATE INDEX IF NOT EXISTS netshift_world_progress_target_idx
      ON netshift_world_player_target_progress (target_slug, probe_count DESC);

    CREATE TABLE IF NOT EXISTS netshift_world_events (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      actor_username VARCHAR(20) NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      target_slug VARCHAR(40) REFERENCES netshift_world_targets(slug) ON DELETE SET NULL,
      summary VARCHAR(240) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS netshift_world_events_created_idx
      ON netshift_world_events (created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS netshift_world_events_target_idx
      ON netshift_world_events (target_slug, created_at DESC);

    -- One owner session per account. The session identifier is the Express session ID,
    -- not a client-supplied tab ID, so all tabs in one browser session share ownership.
    CREATE TABLE IF NOT EXISTS netshift_account_ownership (
      user_id BIGINT PRIMARY KEY REFERENCES netshift_users(id) ON DELETE CASCADE,
      session_id VARCHAR NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS netshift_account_ownership_seen_idx
      ON netshift_account_ownership (last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS netshift_login_handoffs (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES netshift_users(id) ON DELETE CASCADE,
      requester_session_id VARCHAR NOT NULL,
      incumbent_session_id VARCHAR NOT NULL,
      requester_username VARCHAR(20) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','expired','cancelled','completed')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS netshift_handoffs_status_idx
      ON netshift_login_handoffs (user_id, status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS netshift_one_pending_handoff_per_user
      ON netshift_login_handoffs (user_id) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS netshift_world_chat (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      actor_username VARCHAR(20) NOT NULL,
      message VARCHAR(300) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS netshift_world_chat_created_idx
      ON netshift_world_chat (created_at DESC, id DESC);

    -- NETSHIFT Core v2: canonical, server-authoritative player and shared-host state.
    CREATE TABLE IF NOT EXISTS netshift_player_world (
      user_id BIGINT PRIMARY KEY REFERENCES netshift_users(id) ON DELETE CASCADE,
      workstation_ip INET NOT NULL UNIQUE,
      safety_shield BOOLEAN NOT NULL DEFAULT TRUE,
      shield_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pvp_immune_until TIMESTAMPTZ,
      bank_setup_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS netshift_bank_accounts (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id BIGINT REFERENCES netshift_users(id) ON DELETE CASCADE,
      bank_code VARCHAR(32) NOT NULL,
      account_number VARCHAR(24) NOT NULL UNIQUE,
      account_username VARCHAR(40) NOT NULL UNIQUE,
      password_hash TEXT,
      balance_cents BIGINT NOT NULL DEFAULT 50000 CHECK (balance_cents >= 0),
      is_player BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(owner_user_id)
    );
    CREATE TABLE IF NOT EXISTS netshift_player_files (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES netshift_users(id) ON DELETE CASCADE,
      parent_path VARCHAR(500) NOT NULL DEFAULT '/',
      name VARCHAR(180) NOT NULL,
      item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('file','folder','software')),
      mime_type VARCHAR(100) NOT NULL DEFAULT 'text/plain',
      content TEXT NOT NULL DEFAULT '',
      software_family VARCHAR(40),
      software_level SMALLINT CHECK (software_level BETWEEN 1 AND 6),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, parent_path, name)
    );
    CREATE INDEX IF NOT EXISTS netshift_player_files_user_idx ON netshift_player_files(user_id, deleted_at, parent_path);
    CREATE TABLE IF NOT EXISTS netshift_world_host_inventory (
      target_slug VARCHAR(40) PRIMARY KEY REFERENCES netshift_world_targets(slug) ON DELETE CASCADE,
      stock JSONB NOT NULL DEFAULT '[]'::jsonb,
      money_cents BIGINT NOT NULL DEFAULT 0 CHECK (money_cents >= 0),
      last_intrusion_at TIMESTAMPTZ,
      next_regen_at TIMESTAMPTZ,
      credential_lock_until TIMESTAMPTZ,
      inventory_version BIGINT NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS netshift_world_loot_claims (
      id BIGSERIAL PRIMARY KEY,
      target_slug VARCHAR(40) NOT NULL REFERENCES netshift_world_targets(slug) ON DELETE CASCADE,
      item_key VARCHAR(120) NOT NULL,
      claimed_by_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      regen_after TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS netshift_admin_roles (
      user_id BIGINT PRIMARY KEY REFERENCES netshift_users(id) ON DELETE CASCADE,
      granted_by VARCHAR(100) NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mfa_required BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS netshift_admin_audit (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      actor_username VARCHAR(20) NOT NULL,
      action VARCHAR(60) NOT NULL,
      subject_username VARCHAR(20),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS netshift_admin_audit_created_idx ON netshift_admin_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS netshift_user_bans (
      user_id BIGINT PRIMARY KEY REFERENCES netshift_users(id) ON DELETE CASCADE,
      banned_by_user_id BIGINT REFERENCES netshift_users(id) ON DELETE SET NULL,
      reason VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Seed the shared public-host directory idempotently. Target counters and probe history
  // are preserved on restarts and redeploys.
  for (const target of WORLD_TARGET_SEEDS) {
    await pool.query(`
      INSERT INTO netshift_world_targets (slug, name, domain, security_level, description)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        domain = EXCLUDED.domain,
        security_level = EXCLUDED.security_level,
        description = EXCLUDED.description,
        updated_at = NOW()
    `, [target.slug, target.name, target.domain, target.securityLevel, target.description]);
    const stock = [
      { id: `${target.slug}-readme`, name: 'README.txt', type: 'file', content: `Public files for ${target.name}.` },
      { id: `${target.slug}-warez1`, name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1 }
    ];
    await pool.query(`INSERT INTO netshift_world_host_inventory(target_slug,stock,money_cents)
      VALUES($1,$2::jsonb,$3) ON CONFLICT(target_slug) DO NOTHING`, [target.slug, JSON.stringify(stock), target.securityLevel <= 1 ? 25000 : 10000]);
  }
}

const WORLD_TARGET_SEEDS = [
  { slug: 'finance', name: 'Small Finance Co.', domain: 'smallfinance.local', securityLevel: 0, description: 'Small financial-services host; a low-security tutorial target.' },
  { slug: 'hacker', name: 'Forgetful Hacker', domain: 'forgottenpc.local', securityLevel: 1, description: 'A personal workstation with basic password protection.' },
  { slug: 'bank', name: 'First Bank Online', domain: 'firstbank.local', securityLevel: 1, description: 'Fictional bank host; customer balances remain in each player sandbox for now.' },
  { slug: 'pawperfect', name: 'PawPerfect Pet Nutrition', domain: 'pawperfect.pet', securityLevel: 1, description: 'Premium nutrition for happy pets.' },
  { slug: 'chrono', name: 'Chrono Watch Enthusiasts', domain: 'chronowatch.club', securityLevel: 1, description: 'A community for horology enthusiasts.' },
  { slug: 'terry', name: 'Terry Schwarz — Personal Home Page', domain: 'terryschwarz.me', securityLevel: 1, description: 'A personal site belonging to Terry Schwarz.' },
  { slug: 'acorn', name: 'Acorn Student Union', domain: 'acornstudents.org', securityLevel: 0, description: 'Campus groups, events and noticeboards.' },
  { slug: 'pixelarcade', name: 'Pixel Arcade', domain: 'pixelarcade.games', securityLevel: 1, description: 'Retro games and online high scores.' },
  { slug: 'northstar', name: 'Northstar Vendors Marketplace', domain: 'northstar.market', securityLevel: 3, description: 'Commercial vendor marketplace and payment services.' },
  { slug: 'gardenly', name: 'Gardenly Community Gardens', domain: 'gardenly.green', securityLevel: 1, description: 'Local gardening groups and seed exchanges.' },
  { slug: 'zeroday', name: 'Zero-Day Bulletin Board', domain: 'zeroday.board', securityLevel: 2, description: 'A technical bulletin board for security researchers.' },
  { slug: 'retroview', name: 'RetroView Image Gallery', domain: 'retroview.gallery', securityLevel: 0, description: 'An archive of classic computing art and images.' },
  { slug: 'orbital', name: 'Orbital Freight Logistics', domain: 'orbitalfreight.biz', securityLevel: 2, description: 'Shipping, tracking and freight coordination.' },
  { slug: 'tinyhome', name: 'Tiny Home Network', domain: 'tinyhomes.network', securityLevel: 1, description: 'Small-space living ideas and discussion.' },
  { slug: 'bluebird', name: 'Bluebird Media Studio', domain: 'bluebird.media', securityLevel: 2, description: 'An independent digital media studio.' },
  { slug: 'crown', name: 'Crown Reserve Bank', domain: 'crownreserve.bank', securityLevel: 4, description: 'Private banking and high-value reserve accounts.' },
  { slug: 'neon', name: 'Neon Circuit Components', domain: 'neoncircuit.parts', securityLevel: 2, description: 'Specialist electronics and computer components.' }
];
const WORLD_ROOM = 'world:lobby';
const SESSION_ROOM_PREFIX = 'account-session:';
const onlinePlayers = new Map(); // user ID -> { user, socketIds:Set }; the ownership lock permits one session per account.
const chatRateBuckets = new Map();
let sessionStore = null;
let io = null;
let httpServer = null;

function worldOnlineList() {
  return [...onlinePlayers.values()]
    .map(entry => ({ id: entry.user.id, username: entry.user.username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}
function broadcastWorldPresence() {
  if (io) io.to(WORLD_ROOM).emit('world:presence', { players: worldOnlineList() });
}
function mapWorldTarget(row) {
  return {
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    securityLevel: Number(row.security_level),
    description: row.description,
    probeCount: Number(row.probe_count || 0),
    lastProbedByUsername: row.last_probed_by_username || null,
    lastProbedAt: row.last_probed_at || null,
    compromisedByUsername: row.compromised_by_username || null,
    compromisedAt: row.compromised_at || null
  };
}
function mapWorldEvent(row) {
  return {
    id: String(row.id),
    actorUsername: row.actor_username,
    type: row.event_type,
    targetSlug: row.target_slug,
    targetName: row.target_name || null,
    summary: row.summary,
    createdAt: row.created_at
  };
}
function mapWorldChat(row) {
  return { id: String(row.id), username: row.actor_username, message: row.message, createdAt: row.created_at };
}
function sessionRoom(sessionId) { return `${SESSION_ROOM_PREFIX}${sessionId}`; }
function hasConnectedSession(sessionId) {
  if (!io || !sessionId) return false;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.sessionId === sessionId && socket.connected) return true;
  }
  return false;
}
function emitToSession(sessionId, event, payload) {
  if (io && sessionId) io.to(sessionRoom(sessionId)).emit(event, payload);
}
async function readWorldSnapshot(userId) {
  const [targetResult, eventResult, chatResult] = await Promise.all([
    pool.query(`SELECT t.slug, t.name, t.domain, t.security_level, t.description, t.probe_count,
                       t.last_probed_by_username, t.last_probed_at, t.compromised_by_username, t.compromised_at,
                       COALESCE(p.probe_count, 0) AS player_probe_count,
                       p.last_attack_at AS player_last_attack_at, p.last_attack_result AS player_last_attack_result
                FROM netshift_world_targets t
                LEFT JOIN netshift_world_player_target_progress p
                  ON p.target_slug = t.slug AND p.user_id = $1
                ORDER BY t.security_level, t.name`, [userId]),
    pool.query(`SELECT e.id, e.actor_username, e.event_type, e.target_slug, e.summary, e.created_at,
                       t.name AS target_name
                FROM netshift_world_events e
                LEFT JOIN netshift_world_targets t ON t.slug = e.target_slug
                ORDER BY e.created_at DESC, e.id DESC LIMIT 30`),
    pool.query(`SELECT id, actor_username, message, created_at
                FROM netshift_world_chat ORDER BY id DESC LIMIT 40`)
  ]);
  return {
    players: worldOnlineList(),
    targets: targetResult.rows.map(row => ({
      ...mapWorldTarget(row),
      myProbeCount: Number(row.player_probe_count || 0),
      myLastAttackAt: row.player_last_attack_at || null,
      myLastAttackResult: row.player_last_attack_result || null
    })),
    events: eventResult.rows.map(mapWorldEvent),
    chat: chatResult.rows.reverse().map(mapWorldChat),
    updatedAt: new Date().toISOString()
  };
}


function generatedGameIp(userId) {
  // Stable, unique simulated IPv4 space; never derived from the player's real IP.
  const n = BigInt(userId);
  return `10.${Number((n / 65536n) % 200n) + 20}.${Number((n / 254n) % 254n) + 1}.${Number(n % 254n) + 1}`;
}
async function ensurePlayerWorld(user) {
  const ip = generatedGameIp(user.id);
  await pool.query(`INSERT INTO netshift_player_world (user_id, workstation_ip)
    VALUES ($1, $2::inet) ON CONFLICT (user_id) DO NOTHING`, [user.id, ip]);
  // Deterministic account numbers; player credentials are separate from hackable NPC files.
  const accountNo = `10${String(user.id).padStart(10, '0')}`;
  const accountUser = `player_${String(user.id)}`;
  await pool.query(`INSERT INTO netshift_bank_accounts
    (owner_user_id, bank_code, account_number, account_username, balance_cents, is_player)
    VALUES ($1, 'FIRST', $2, $3, 50000, TRUE) ON CONFLICT (owner_user_id) DO NOTHING`, [user.id, accountNo, accountUser]);
  await pool.query(`INSERT INTO netshift_player_files (id, user_id, parent_path, name, item_type, content)
    VALUES ($1, $2, '/', 'README.txt', 'file', 'Welcome to NETSHIFT. Keep notes on IP addresses and passwords here.')
    ON CONFLICT (user_id, parent_path, name) DO NOTHING`, [crypto.randomUUID(), user.id]);
  return (await pool.query(`SELECT p.workstation_ip::text AS workstation_ip, p.safety_shield, p.shield_changed_at,
      p.pvp_immune_until, p.bank_setup_at, b.bank_code, b.account_number, b.account_username,
      b.balance_cents, b.password_hash IS NOT NULL AS bank_setup
    FROM netshift_player_world p JOIN netshift_bank_accounts b ON b.owner_user_id = p.user_id
    WHERE p.user_id = $1`, [user.id])).rows[0];
}
async function requireSessionOwnership(req, res) {
  const owner = await pool.query('SELECT session_id FROM netshift_account_ownership WHERE user_id = $1', [req.session.user.id]);
  if (!owner.rowCount || owner.rows[0].session_id !== req.sessionID) {
    res.status(401).json({ error: 'This session no longer owns the account.', code: 'SESSION_REVOKED' });
    return false;
  }
  return true;
}
async function requireAdmin(req, res, next) {
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const result = await pool.query('SELECT 1 FROM netshift_admin_roles WHERE user_id = $1', [req.session.user.id]);
    if (!result.rowCount) return res.status(403).json({ error: 'Administrator permission required.' });
    req.isNetshiftAdmin = true;
    next();
  } catch (error) { next(error); }
}
async function auditAdmin(actor, action, subject = null, detail = {}) {
  await pool.query(`INSERT INTO netshift_admin_audit (actor_user_id, actor_username, action, subject_username, detail)
    VALUES ($1, $2, $3, $4, $5::jsonb)`, [actor.id, actor.username, action, subject, JSON.stringify(detail)]);
}

const app = express();
// Render and other reverse proxies terminate HTTPS before forwarding traffic.
if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
// This legacy game uses inline styles and inline onclick handlers. A restrictive CSP
// would break the current UI; CSP should be tightened after that code is modularised.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '4mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const PgSessionStore = connectPgSimple(session);
sessionStore = new PgSessionStore({ pool, tableName: 'netshift_sessions', createTableIfMissing: false });
const netshiftSessionMiddleware = session({
  name: 'netshift.sid',
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});
app.use(netshiftSessionMiddleware);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many account attempts. Please wait 15 minutes and try again.' }
});
const saveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Autosave limit reached. Please wait a moment.' }
});
const worldProbeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Shared-network action limit reached. Please wait a moment.' }
});
const worldBreachLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Intrusion attempt limit reached. Please wait a moment.' }
});

function safeUser(user) { return { id: String(user.id), username: user.username }; }
async function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  try {
    const ownership = await pool.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW()
      WHERE user_id = $1 AND session_id = $2 RETURNING user_id`, [req.session.user.id, req.sessionID]);
    if (!ownership.rowCount) {
      return res.status(401).json({ error: 'This session no longer owns the account. Sign in again.', code: 'SESSION_REVOKED' });
    }
    next();
  } catch (error) { next(error); }
}
function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(username);
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}
function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}
function regeneratePendingLoginSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.pendingLoginUser = safeUser(user);
      req.session.save(saveError => saveError ? reject(saveError) : resolve());
    });
  });
}
async function activatePendingLoginSession(req, user) {
  req.session.user = safeUser(user);
  delete req.session.pendingLoginUser;
  delete req.session.pendingHandoffId;
  await saveSession(req);
  return req.session.user;
}
function clearSessionCookie(res) {
  res.clearCookie('netshift.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
}
function destroyRequestSession(req, res) {
  return new Promise(resolve => {
    if (!req.session) { clearSessionCookie(res); return resolve(); }
    req.session.destroy(() => { clearSessionCookie(res); resolve(); });
  });
}
async function claimOwnershipOrRequestHandoff(req, user) {
  const requesterSessionId = req.sessionID;
  const client = await pool.connect();
  let result;
  let expiredSessions = [];
  try {
    await client.query('BEGIN');
    const expired = await client.query(`UPDATE netshift_login_handoffs
      SET status = 'expired', resolved_at = NOW()
      WHERE user_id = $1 AND status = 'pending' AND expires_at <= NOW()
      RETURNING incumbent_session_id, id`, [user.id]);
    expiredSessions = expired.rows;

    await client.query(`INSERT INTO netshift_account_ownership (user_id, session_id)
      VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [user.id, requesterSessionId]);
    const lockResult = await client.query(`SELECT user_id, session_id, last_seen_at
      FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [user.id]);
    const owner = lockResult.rows[0];
    if (!owner) throw new Error('Could not establish account ownership record.');

    if (owner.session_id === requesterSessionId) {
      await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1`, [user.id]);
      result = { kind: 'acquired' };
    } else {
      const stale = Date.now() - new Date(owner.last_seen_at).getTime() > SESSION_LEASE_MS;
      const ownerConnected = hasConnectedSession(owner.session_id);
      if (stale && !ownerConnected) {
        await client.query(`UPDATE netshift_account_ownership SET session_id = $2, claimed_at = NOW(), last_seen_at = NOW()
          WHERE user_id = $1`, [user.id, requesterSessionId]);
        result = { kind: 'acquired' };
      } else if (!ownerConnected) {
        result = { kind: 'unreachable', incumbentSessionId: owner.session_id };
      } else {
        const pending = await client.query(`SELECT id FROM netshift_login_handoffs
          WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() FOR UPDATE`, [user.id]);
        if (pending.rowCount) {
          result = { kind: 'handoff-in-progress' };
        } else {
          const handoffId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
          await client.query(`INSERT INTO netshift_login_handoffs
            (id, user_id, requester_session_id, incumbent_session_id, requester_username, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)`,
            [handoffId, user.id, requesterSessionId, owner.session_id, user.username, expiresAt]);
          result = { kind: 'handoff', id: handoffId, expiresAt, incumbentSessionId: owner.session_id };
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    if (error.code === '23505') return { kind: 'handoff-in-progress' };
    throw error;
  } finally { client.release(); }

  for (const row of expiredSessions) emitToSession(row.incumbent_session_id, 'auth:handoff-expired', { handoffId: row.id });

  if (result.kind === 'acquired') {
    await activatePendingLoginSession(req, user);
  } else if (result.kind === 'handoff') {
    req.session.pendingHandoffId = result.id;
    await saveSession(req);
    emitToSession(result.incumbentSessionId, 'auth:handoff-request', {
      handoffId: result.id, requestingUsername: user.username, expiresAt: result.expiresAt.toISOString()
    });
    setTimeout(() => expireHandoff(result.id), HANDOFF_TTL_MS + 250).unref();
  }
  return result;
}
async function expireHandoff(handoffId) {
  try {
    const result = await pool.query(`UPDATE netshift_login_handoffs SET status = 'expired', resolved_at = NOW()
      WHERE id = $1 AND status = 'pending' AND expires_at <= NOW() RETURNING id, incumbent_session_id`, [handoffId]);
    if (result.rowCount) emitToSession(result.rows[0].incumbent_session_id, 'auth:handoff-expired', { handoffId: result.rows[0].id });
  } catch (error) { console.error('Could not expire account handoff:', error.message); }
}
async function adoptLegacySession(req) {
  const user = req.session.user;
  if (!user) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO netshift_account_ownership (user_id, session_id)
      VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [user.id, req.sessionID]);
    const update = await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW()
      WHERE user_id = $1 AND session_id = $2 RETURNING user_id`, [user.id, req.sessionID]);
    await client.query('COMMIT');
    return update.rowCount > 0;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'netshift-online', database: 'connected', realtime: 'enabled' });
  } catch (error) {
    console.error('Health check database error:', error.message);
    res.status(503).json({ ok: false, service: 'netshift-online', database: 'unavailable' });
  }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (req.session.pendingLoginUser) {
      if (req.session.pendingHandoffId) {
        return res.json({ user: null, pendingHandoffId: req.session.pendingHandoffId,
          pendingUsername: req.session.pendingLoginUser.username });
      }
      await destroyRequestSession(req, res);
      return res.json({ user: null });
    }
    if (!req.session.user) return res.json({ user: null });
    const ownsSession = await adoptLegacySession(req);
    if (!ownsSession) {
      await destroyRequestSession(req, res);
      return res.json({ user: null, code: 'SESSION_REVOKED', message: 'This account is already active in another session. Sign in and request access from that session.' });
    }
    res.json({ user: req.session.user });
  } catch (error) { next(error); }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  if (req.session.user) return res.status(409).json({ error: 'You are already signed in. Log out before creating another account.', code: 'ALREADY_SIGNED_IN' });
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'Choose a username of 3–20 letters, numbers or underscores.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Choose a password between 12 and 128 characters.' });
  let pendingSessionCreated = false;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO netshift_users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.toLowerCase(), passwordHash]
    );
    await regeneratePendingLoginSession(req, result.rows[0]);
    pendingSessionCreated = true;
    const ownership = await claimOwnershipOrRequestHandoff(req, result.rows[0]);
    if (ownership.kind !== 'acquired') {
      await destroyRequestSession(req, res);
      return res.status(409).json({ error: 'Account ownership could not be established for this new account. Please sign in again.', code: 'OWNERSHIP_FAILED' });
    }
    await ensurePlayerWorld(result.rows[0]);
    res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    if (pendingSessionCreated) await destroyRequestSession(req, res);
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  if (req.session.user) return res.status(409).json({ error: 'This browser session is already signed in. Log out before switching accounts.', code: 'ALREADY_SIGNED_IN' });
  if (req.session.pendingLoginUser) return res.status(409).json({ error: 'A sign-in request is already pending in this browser.', code: 'HANDOFF_PENDING' });
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!validUsername(username) || password.length < 1 || password.length > 128) {
    return res.status(400).json({ error: 'Enter a valid username and password.' });
  }
  let pendingSessionCreated = false;
  try {
    const result = await pool.query('SELECT id, username, password_hash FROM netshift_users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Sign-in failed. Check your username and password.' });
    }
    const ban = await pool.query('SELECT reason FROM netshift_user_bans WHERE user_id = $1', [user.id]);
    if (ban.rowCount) return res.status(403).json({ error: 'This account is banned.', code: 'ACCOUNT_BANNED' });
    // Regenerate first to prevent session fixation. The candidate is not authenticated
    // until a free ownership slot is acquired or the current session approves handoff.
    await regeneratePendingLoginSession(req, user);
    pendingSessionCreated = true;
    const ownership = await claimOwnershipOrRequestHandoff(req, user);
    if (ownership.kind === 'acquired') { await ensurePlayerWorld(user); return res.json({ user: safeUser(user) }); }
    if (ownership.kind === 'handoff') {
      return res.status(202).json({ handoffRequired: true, handoffId: ownership.id,
        waitingFor: user.username, expiresAt: ownership.expiresAt.toISOString(),
        message: 'This account is active elsewhere. The current session must approve the sign-in.' });
    }
    await destroyRequestSession(req, res);
    if (ownership.kind === 'unreachable') {
      return res.status(409).json({ error: 'This account is still signed in, but its active session cannot currently be reached. Reconnect that session or wait for it to become inactive before retrying.', code: 'ACTIVE_SESSION_UNREACHABLE' });
    }
    return res.status(409).json({ error: 'A sign-in handoff is already pending for this account. Ask the active session to respond, then try again.', code: 'HANDOFF_IN_PROGRESS' });
  } catch (error) {
    if (pendingSessionCreated) await destroyRequestSession(req, res);
    next(error);
  }
});

app.post('/api/auth/heartbeat', requireAuth, (_req, res) => {
  res.json({ ok: true, heartbeatIntervalMs: SESSION_HEARTBEAT_INTERVAL_MS });
});

app.get('/api/auth/handoff/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid handoff identifier.' });
  const pendingUser = req.session.pendingLoginUser;
  if (!pendingUser || req.session.pendingHandoffId !== id) return res.status(401).json({ error: 'This sign-in request is no longer active.', code: 'HANDOFF_SESSION_INVALID' });
  try {
    await expireHandoff(id);
    const result = await pool.query(`SELECT status, expires_at FROM netshift_login_handoffs
      WHERE id = $1 AND user_id = $2 AND requester_session_id = $3`, [id, pendingUser.id, req.sessionID]);
    if (!result.rowCount) {
      await destroyRequestSession(req, res);
      return res.status(404).json({ error: 'Sign-in handoff not found.', code: 'HANDOFF_NOT_FOUND' });
    }
    const status = result.rows[0].status;
    if (['denied','expired','cancelled'].includes(status)) {
      await destroyRequestSession(req, res);
      return res.json({ status, message: status === 'denied' ? 'The active session declined the sign-in request.' : 'The sign-in request expired or was cancelled. Submit the login form to try again.' });
    }
    res.json({ status, expiresAt: result.rows[0].expires_at });
  } catch (error) { next(error); }
});

app.post('/api/auth/handoff/:id/complete', async (req, res, next) => {
  const id = req.params.id;
  const pendingUser = req.session.pendingLoginUser;
  if (!pendingUser || req.session.pendingHandoffId !== id) return res.status(401).json({ error: 'This sign-in request is no longer active.', code: 'HANDOFF_SESSION_INVALID' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const handoff = await client.query(`SELECT status, user_id, requester_session_id FROM netshift_login_handoffs
      WHERE id = $1 FOR UPDATE`, [id]);
    const owner = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [pendingUser.id]);
    if (!handoff.rowCount || handoff.rows[0].status !== 'approved' || String(handoff.rows[0].user_id) !== String(pendingUser.id) ||
        handoff.rows[0].requester_session_id !== req.sessionID || !owner.rowCount || owner.rows[0].session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The active session has not approved this handoff.', code: 'HANDOFF_NOT_APPROVED' });
    }
    await client.query('COMMIT');
    await activatePendingLoginSession(req, pendingUser);
    await pool.query(`UPDATE netshift_login_handoffs SET status = 'completed', resolved_at = NOW()
      WHERE id = $1 AND status = 'approved'`, [id]);
    res.json({ user: safeUser(pendingUser) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/handoff/:id/respond', requireAuth, async (req, res, next) => {
  const id = req.params.id;
  const decision = req.body?.decision;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid handoff identifier.' });
  if (!['yes','no'].includes(decision)) return res.status(400).json({ error: 'Choose Yes or No to resolve the sign-in request.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const handoffResult = await client.query(`SELECT id, user_id, requester_session_id, incumbent_session_id, status, expires_at
      FROM netshift_login_handoffs WHERE id = $1 FOR UPDATE`, [id]);
    if (!handoffResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sign-in request not found.' });
    }
    const handoff = handoffResult.rows[0];
    if (String(handoff.user_id) !== String(req.session.user.id) || handoff.incumbent_session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the active session can decide this request.' });
    }
    if (handoff.status !== 'pending' || new Date(handoff.expires_at).getTime() <= Date.now()) {
      if (handoff.status === 'pending') await client.query(`UPDATE netshift_login_handoffs SET status = 'expired', resolved_at = NOW() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      if (decision === 'no') {
        // The incumbent must be able to dismiss an expired/cancelled prompt without
        // losing ownership. This is the only valid decision once the request is stale.
        emitToSession(handoff.incumbent_session_id, 'auth:handoff-declined', { handoffId: id });
        return res.json({ ok: true, decision: 'no', expired: true });
      }
      emitToSession(handoff.incumbent_session_id, 'auth:handoff-expired', { handoffId: id });
      return res.status(410).json({ error: 'This sign-in request has expired. Select No to dismiss it and keep your session.', code: 'HANDOFF_EXPIRED' });
    }
    if (decision === 'no') {
      await client.query(`UPDATE netshift_login_handoffs SET status = 'denied', resolved_at = NOW() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      emitToSession(handoff.incumbent_session_id, 'auth:handoff-declined', { handoffId: id });
      return res.json({ ok: true, decision: 'no' });
    }
    const owner = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [req.session.user.id]);
    if (!owner.rowCount || owner.rows[0].session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This session no longer owns the account.', code: 'SESSION_REVOKED' });
    }
    await client.query(`UPDATE netshift_account_ownership SET session_id = $2, claimed_at = NOW(), last_seen_at = NOW()
      WHERE user_id = $1`, [req.session.user.id, handoff.requester_session_id]);
    await client.query(`UPDATE netshift_login_handoffs SET status = 'approved', resolved_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');

    emitToSession(handoff.incumbent_session_id, 'auth:session-revoked', {
      reason: 'handoff-approved', message: 'Access was transferred to another sign-in.'
    });
    // Mark old sockets synchronously so they cannot submit chat while they receive the
    // revocation event; state-changing REST routes also verify ownership under DB locks.
    if (io) for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === handoff.incumbent_session_id) socket.data.ownershipRevoked = true;
    }
    setTimeout(() => {
      if (io) for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionId === handoff.incumbent_session_id) socket.disconnect(true);
      }
    }, 250).unref();
    req.session.destroy(error => {
      if (error) console.error('Could not destroy relinquished session:', error.message);
      clearSessionCookie(res);
      res.json({ ok: true, decision: 'yes' });
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/handoff/:id/cancel', async (req, res, next) => {
  const id = req.params.id;
  const pendingUser = req.session.pendingLoginUser;
  if (!pendingUser || req.session.pendingHandoffId !== id) return res.status(401).json({ error: 'This sign-in request is no longer active.' });
  try {
    const result = await pool.query(`UPDATE netshift_login_handoffs SET status = 'cancelled', resolved_at = NOW()
      WHERE id = $1 AND user_id = $2 AND requester_session_id = $3 AND status = 'pending'
      RETURNING incumbent_session_id`, [id, pendingUser.id, req.sessionID]);
    if (result.rowCount) emitToSession(result.rows[0].incumbent_session_id, 'auth:handoff-expired', { handoffId: id, cancelled: true });
    await destroyRequestSession(req, res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  const sessionId = req.sessionID;
  const user = req.session.user;
  try {
    if (io) for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === sessionId) socket.disconnect(true);
    }
    if (user) await pool.query('DELETE FROM netshift_account_ownership WHERE user_id = $1 AND session_id = $2', [user.id, sessionId]);
    req.session.destroy(error => {
      if (error) return next(error);
      clearSessionCookie(res);
      res.json({ ok: true });
    });
  } catch (error) { next(error); }
});

app.get('/api/save', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT save_data, updated_at, revision FROM netshift_saves WHERE user_id = $1', [req.session.user.id]);
    if (!result.rowCount) return res.json({ save: null, updatedAt: null, revision: 0 });
    res.json({ save: result.rows[0].save_data, updatedAt: result.rows[0].updated_at, revision: Number(result.rows[0].revision) });
  } catch (error) { next(error); }
});

app.post('/api/save', requireAuth, saveLimiter, async (req, res, next) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schemaVersion !== 1 ||
      !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) {
    return res.status(400).json({ error: 'The game save is invalid or uses an unsupported version.' });
  }
  // Revision control prevents an older browser session from silently overwriting a newer save.
  const baseRevision = payload.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    return res.status(428).json({ error: 'This game page is outdated or missing its save revision. Refresh the page before saving.' });
  }
  const saveDocument = { ...payload };
  delete saveDocument.baseRevision;
  let serialised;
  try { serialised = JSON.stringify(saveDocument); }
  catch (_error) { return res.status(400).json({ error: 'The game save could not be serialised.' }); }
  if (Buffer.byteLength(serialised, 'utf8') > 3 * 1024 * 1024) {
    return res.status(413).json({ error: 'Save data is too large (maximum 3 MB).' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [req.session.user.id]);
    if (!ownership.rowCount || ownership.rows[0].session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'This session no longer owns the account. Sign in again.', code: 'SESSION_REVOKED' });
    }
    await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1`, [req.session.user.id]);
    let result;
    if (baseRevision === 0) {
      // The first save is allowed only when there is still no save row for this account.
      result = await client.query(`
        INSERT INTO netshift_saves (user_id, save_data, updated_at, revision)
        VALUES ($1, $2::jsonb, NOW(), 1)
        ON CONFLICT (user_id) DO NOTHING
        RETURNING updated_at, revision
      `, [req.session.user.id, serialised]);
    } else {
      result = await client.query(`
        UPDATE netshift_saves
        SET save_data = $2::jsonb, updated_at = NOW(), revision = revision + 1
        WHERE user_id = $1 AND revision = $3
        RETURNING updated_at, revision
      `, [req.session.user.id, serialised, baseRevision]);
    }

    if (!result.rowCount) {
      const latest = await client.query('SELECT revision FROM netshift_saves WHERE user_id = $1', [req.session.user.id]);
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This save changed in another session. Load the latest save before continuing to save.',
        currentRevision: latest.rowCount ? Number(latest.rows[0].revision) : 0
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, updatedAt: result.rows[0].updated_at, revision: Number(result.rows[0].revision) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* original error takes priority */ }
    next(error);
  } finally {
    client.release();
  }
});


// NETSHIFT Core v2 APIs. All mutating gameplay actions validate ownership server-side.
app.get('/api/core/profile', requireAuth, async (req, res, next) => {
  try {
    const profile = await ensurePlayerWorld(req.session.user);
    res.json({ profile: { ip: profile.workstation_ip, safetyShield: profile.safety_shield,
      shieldChangedAt: profile.shield_changed_at, pvpImmuneUntil: profile.pvp_immune_until,
      bankSetup: profile.bank_setup, bank: { bank: profile.bank_code, accountNumber: profile.account_number,
      username: profile.account_username, balance: Number(profile.balance_cents) / 100 } } });
  } catch (e) { next(e); }
});
app.post('/api/core/safetyshield', requireAuth, async (req, res, next) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const row = await c.query('SELECT safety_shield, shield_changed_at FROM netshift_player_world WHERE user_id=$1 FOR UPDATE', [req.session.user.id]);
      if (!row.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Player profile missing.' }); }
      const current = row.rows[0];
      if (current.safety_shield === enabled) { await c.query('COMMIT'); return res.json({ ok: true, safetyShield: enabled, unchanged: true }); }
      const remaining = 3600000 - (Date.now() - new Date(current.shield_changed_at).getTime());
      if (remaining > 0) { await c.query('ROLLBACK'); return res.status(429).json({ error: 'SafetyShield can only be changed once per hour.', code: 'SHIELD_COOLDOWN', remainingMs: remaining }); }
      await c.query('UPDATE netshift_player_world SET safety_shield=$2, shield_changed_at=NOW() WHERE user_id=$1', [req.session.user.id, enabled]);
      await c.query('COMMIT');
      if (io) io.to(WORLD_ROOM).emit('world:shield-change', { username: req.session.user.username, enabled });
      res.json({ ok: true, safetyShield: enabled, changedAt: new Date().toISOString() });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; } finally { c.release(); }
  } catch (e) { next(e); }
});
app.post('/api/core/bank/first-login', requireAuth, async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9_]{3,40}$/.test(username) || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Choose a bank username (3–40 letters/numbers/underscores) and password (8–128 characters).' });
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const p = await c.query('SELECT bank_setup_at FROM netshift_player_world WHERE user_id=$1 FOR UPDATE', [req.session.user.id]);
      if (!p.rowCount) throw new Error('Player profile missing.');
      const existing = await c.query('SELECT password_hash FROM netshift_bank_accounts WHERE owner_user_id=$1 FOR UPDATE', [req.session.user.id]);
      if (existing.rows[0].password_hash) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'First Bank credentials have already been created.' }); }
      const collision = await c.query('SELECT 1 FROM netshift_bank_accounts WHERE account_username=$1', [username]);
      if (collision.rowCount) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'That bank username is already taken.' }); }
      const hash = await bcrypt.hash(password, 12);
      await c.query('UPDATE netshift_bank_accounts SET account_username=$2, password_hash=$3 WHERE owner_user_id=$1', [req.session.user.id, username, hash]);
      await c.query('UPDATE netshift_player_world SET bank_setup_at=NOW() WHERE user_id=$1', [req.session.user.id]);
      await c.query('COMMIT');
      res.json({ ok: true, welcomeBonus: 500, currency: 'USD', message: 'First Bank account activated. The one-time $500 welcome bonus is included in your opening balance.' });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} if (e.message === 'Player profile missing.') return res.status(404).json({ error: e.message }); throw e; } finally { c.release(); }
  } catch (e) { next(e); }
});
app.get('/api/core/files', requireAuth, async (req, res, next) => {
  try {
    const rows = await pool.query(`SELECT id, parent_path, name, item_type, mime_type, content, software_family, software_level, created_at, updated_at
      FROM netshift_player_files WHERE user_id=$1 AND deleted_at IS NULL ORDER BY parent_path, item_type DESC, name`, [req.session.user.id]);
    res.json({ files: rows.rows });
  } catch (e) { next(e); }
});
app.post('/api/core/files', requireAuth, async (req, res, next) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const parent = typeof req.body?.parentPath === 'string' ? req.body.parentPath : '/';
  const type = req.body?.type;
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  if (!name || name.length > 180 || /[\\/\0]/.test(name) || name === '.' || name === '..') return res.status(400).json({ error: 'Invalid file or folder name.' });
  if (!parent.startsWith('/') || parent.length > 500 || parent.includes('..')) return res.status(400).json({ error: 'Invalid folder path.' });
  if (!['file','folder'].includes(type)) return res.status(400).json({ error: 'type must be file or folder.' });
  if (content.length > 100000) return res.status(413).json({ error: 'Text files are limited to 100 KB.' });
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const segments = parent.split('/').filter(Boolean);
    const parentName = segments.at(-1);
    const parentPath = segments.length > 1 ? '/' + segments.slice(0, -1).join('/') : '/';
    const parentExists = parent === '/' || (await pool.query(`SELECT 1 FROM netshift_player_files WHERE user_id=$1 AND name=$2 AND parent_path=$3 AND item_type='folder' AND deleted_at IS NULL`, [req.session.user.id, parentName, parentPath])).rowCount;
    if (!parentExists) return res.status(404).json({ error: 'Parent folder not found.' });
    const id = crypto.randomUUID();
    const result = await pool.query(`INSERT INTO netshift_player_files (id,user_id,parent_path,name,item_type,content)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,parent_path,name,item_type,content,created_at`, [id, req.session.user.id, parent, name, type, type === 'folder' ? '' : content]);
    res.status(201).json({ file: result.rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'A file or folder with that name already exists here.' }); next(e); }
});
app.put('/api/core/files/:id', requireAuth, async (req, res, next) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  if (content === null || content.length > 100000) return res.status(400).json({ error: 'Provide text content up to 100 KB.' });
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const result = await pool.query(`UPDATE netshift_player_files SET content=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND item_type='file' AND deleted_at IS NULL RETURNING id,name,content,updated_at`, [req.params.id, req.session.user.id, content]);
    if (!result.rowCount) return res.status(404).json({ error: 'File not found or not editable.' });
    res.json({ file: result.rows[0] });
  } catch (e) { next(e); }
});
app.delete('/api/core/files/:id', requireAuth, async (req, res, next) => {
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const result = await pool.query(`UPDATE netshift_player_files SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id,name`, [req.params.id, req.session.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'File not found.' });
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (e) { next(e); }
});
app.post('/api/core/hosts/:slug/download', requireAuth, async (req, res, next) => {
  try {
    if (!await requireSessionOwnership(req, res)) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const host = await c.query('SELECT target_slug, stock, credential_lock_until FROM netshift_world_host_inventory WHERE target_slug=$1 FOR UPDATE', [req.params.slug]);
      if (!host.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'Host inventory is not available.' }); }
      const stock = host.rows[0].stock;
      const itemId = String(req.body?.itemId || '');
      const item = stock.find(x => x.id === itemId);
      if (!item) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'ERROR: This item is no longer available on the host.' }); }
      const updated = stock.filter(x => x.id !== itemId);
      const credential = /account|bank|credential/i.test(String(item.name || ''));
      await c.query(`UPDATE netshift_world_host_inventory SET stock=$2::jsonb, inventory_version=inventory_version+1,
        last_intrusion_at=COALESCE(last_intrusion_at,NOW()), next_regen_at=COALESCE(next_regen_at,NOW()+INTERVAL '5 minutes'),
        credential_lock_until=CASE WHEN $3 THEN NOW()+INTERVAL '3 days' ELSE credential_lock_until END WHERE target_slug=$1`, [req.params.slug, JSON.stringify(updated), credential]);
      await c.query(`INSERT INTO netshift_world_loot_claims (target_slug,item_key,claimed_by_user_id,regen_after) VALUES ($1,$2,$3,NOW()+INTERVAL '5 minutes')`, [req.params.slug, item.id, req.session.user.id]);
      const itemName = String(item.name || 'download.txt').slice(0, 180);
      const isSoftware = item.type === 'software';
      await c.query(`INSERT INTO netshift_player_files
        (id,user_id,parent_path,name,item_type,content,software_family,software_level)
        VALUES($1,$2,'/downloads',$3,$4,$5,$6,$7)
        ON CONFLICT(user_id,parent_path,name) DO NOTHING`, [crypto.randomUUID(), req.session.user.id, itemName, isSoftware ? 'software' : 'file', String(item.content || ''), isSoftware ? String(item.family || 'utility') : null, isSoftware ? Math.max(1, Math.min(6, Number(item.level) || 1)) : null]);
      await c.query('COMMIT');
      res.json({ ok: true, item, message: 'Download complete.' });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; } finally { c.release(); }
  } catch (e) { next(e); }
});
app.get('/api/admin/viewusers', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT u.username,u.created_at,(o.last_seen_at > NOW()-INTERVAL '60 seconds') AS online,
      p.workstation_ip::text AS workstation_ip FROM netshift_users u LEFT JOIN netshift_account_ownership o ON o.user_id=u.id
      LEFT JOIN netshift_player_world p ON p.user_id=u.id ORDER BY online DESC,u.username`);
    await auditAdmin(req.session.user, 'viewusers'); res.json({ users: result.rows });
  } catch (e) { next(e); }
});
app.post('/api/admin/:action/:username', requireAuth, requireAdmin, async (req, res, next) => {
  const action = req.params.action;
  const username = String(req.params.username || '').toLowerCase();
  if (!['kick','ban','unban'].includes(action) || !/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Invalid admin action or username.' });
  try {
    const target = await pool.query('SELECT id,username FROM netshift_users WHERE username=$1', [username]);
    if (!target.rowCount) return res.status(404).json({ error: 'User not found.' });
    if (String(target.rows[0].id) === String(req.session.user.id)) return res.status(400).json({ error: 'You cannot apply this action to your own account.' });
    if (action === 'kick') await pool.query('DELETE FROM netshift_account_ownership WHERE user_id=$1', [target.rows[0].id]);
    if (action === 'ban') {
      await pool.query(`INSERT INTO netshift_user_bans(user_id,banned_by_user_id,reason) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET banned_by_user_id=EXCLUDED.banned_by_user_id,reason=EXCLUDED.reason,created_at=NOW()`, [target.rows[0].id, req.session.user.id, String(req.body?.reason || 'Administrative ban').slice(0,500)]);
      await pool.query('DELETE FROM netshift_account_ownership WHERE user_id=$1', [target.rows[0].id]);
      await pool.query(`DELETE FROM netshift_sessions WHERE sess->'user'->>'id'=$1`, [String(target.rows[0].id)]);
    }
    if (action === 'unban') await pool.query('DELETE FROM netshift_user_bans WHERE user_id=$1', [target.rows[0].id]);
    await auditAdmin(req.session.user, action, target.rows[0].username, { reason: String(req.body?.reason || '').slice(0,500) });
    res.json({ ok: true, action, username });
  } catch (e) { next(e); }
});
app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT actor_username,action,subject_username,detail,created_at FROM netshift_admin_audit ORDER BY id DESC LIMIT 500`);
    await auditAdmin(req.session.user, 'checkadminlogs'); res.json({ logs: result.rows });
  } catch (e) { next(e); }
});

// Shared multiplayer foundation: this initial slice shares public target metadata and
// server-recorded probe events. It deliberately does not share bank balances or accept
// client-authored money/hack outcomes; those mechanics need separate authoritative commands.
app.get('/api/world/summary', requireAuth, async (req, res, next) => {
  try { res.json(await readWorldSnapshot(req.session.user.id)); }
  catch (error) { next(error); }
});

app.post('/api/world/targets/:slug/probe', requireAuth, worldProbeLimiter, async (req, res, next) => {
  const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return res.status(400).json({ error: 'Invalid target identifier.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [req.session.user.id]);
    if (!ownership.rowCount || ownership.rows[0].session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'This session no longer owns the account. Sign in again.', code: 'SESSION_REVOKED' });
    }
    await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1`, [req.session.user.id]);
    const updated = await client.query(`
      UPDATE netshift_world_targets
      SET probe_count = probe_count + 1,
          last_probed_by_user_id = $2,
          last_probed_by_username = $3,
          last_probed_at = NOW(),
          updated_at = NOW()
      WHERE slug = $1
      RETURNING slug, name, domain, security_level, description, probe_count,
                last_probed_by_username, last_probed_at, compromised_by_username, compromised_at
    `, [slug, req.session.user.id, req.session.user.username]);
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That shared target was not found.' });
    }

    const progress = await client.query(`
      INSERT INTO netshift_world_player_target_progress (user_id, target_slug, probe_count, last_probed_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (user_id, target_slug) DO UPDATE SET
        probe_count = netshift_world_player_target_progress.probe_count + 1,
        last_probed_at = NOW()
      RETURNING probe_count, last_attack_at, last_attack_result
    `, [req.session.user.id, slug]);
    const publicTarget = mapWorldTarget(updated.rows[0]);
    const personalTarget = { ...publicTarget, myProbeCount: Number(progress.rows[0].probe_count), myLastAttackAt: progress.rows[0].last_attack_at || null, myLastAttackResult: progress.rows[0].last_attack_result || null };
    const summary = `${req.session.user.username} probed ${publicTarget.name} (${publicTarget.domain}).`;
    const inserted = await client.query(`
      INSERT INTO netshift_world_events (actor_user_id, actor_username, event_type, target_slug, summary)
      VALUES ($1, $2, 'target.probed', $3, $4)
      RETURNING id, actor_username, event_type, target_slug, summary, created_at
    `, [req.session.user.id, req.session.user.username, publicTarget.slug, summary]);
    const event = mapWorldEvent({ ...inserted.rows[0], target_name: publicTarget.name });
    await client.query('COMMIT');

    if (io) {
      io.to(WORLD_ROOM).emit('world:event', event);
      io.to(WORLD_ROOM).emit('world:target-updated', publicTarget);
    }
    res.json({ ok: true, target: personalTarget, event, result: 'Probe recorded. This operator has now probed the host and may attempt an intrusion.' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    next(error);
  } finally {
    client.release();
  }
});

// This first shared hacking command is resolved by the server: prerequisites, cooldown,
// target difficulty, random outcome, host claim and event are never accepted from client state.
app.post('/api/world/targets/:slug/breach', requireAuth, worldBreachLimiter, async (req, res, next) => {
  const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return res.status(400).json({ error: 'Invalid target identifier.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [req.session.user.id]);
    if (!ownership.rowCount || ownership.rows[0].session_id !== req.sessionID) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'This session no longer owns the account. Sign in again.', code: 'SESSION_REVOKED' });
    }
    await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1`, [req.session.user.id]);

    const targetResult = await client.query(`SELECT slug, name, domain, security_level, description, probe_count,
        last_probed_by_username, last_probed_at, compromised_by_user_id, compromised_by_username, compromised_at
      FROM netshift_world_targets WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!targetResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That shared target was not found.' });
    }
    const current = targetResult.rows[0];
    const progressResult = await client.query(`SELECT probe_count, last_attack_at
      FROM netshift_world_player_target_progress WHERE user_id = $1 AND target_slug = $2 FOR UPDATE`, [req.session.user.id, slug]);
    if (!progressResult.rowCount || Number(progressResult.rows[0].probe_count) < 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Probe this host at least once before attempting an intrusion.', code: 'PROBE_REQUIRED' });
    }
    if (current.compromised_by_user_id != null && String(current.compromised_by_user_id) === String(req.session.user.id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You already control this shared host.', code: 'ALREADY_CONTROLLED' });
    }
    const lastAttackAt = progressResult.rows[0].last_attack_at ? new Date(progressResult.rows[0].last_attack_at).getTime() : 0;
    const cooldownMs = 20000;
    const remainingMs = cooldownMs - (Date.now() - lastAttackAt);
    if (remainingMs > 0) {
      await client.query('ROLLBACK');
      res.setHeader('Retry-After', String(Math.ceil(remainingMs / 1000)));
      return res.status(429).json({ error: `Intrusion cooldown: wait ${Math.ceil(remainingMs / 1000)} seconds before trying this host again.`, code: 'BREACH_COOLDOWN', retryAfterSeconds: Math.ceil(remainingMs / 1000) });
    }

    const securityLevel = Number(current.security_level || 0);
    const contested = current.compromised_by_user_id != null;
    const successChance = worldBreachChance(securityLevel, contested);
    const succeeded = crypto.randomInt(0, 100) < successChance;
    const previousOwner = current.compromised_by_username || null;
    let updatedTargetRow = current;
    let eventType;
    let resultText;
    if (succeeded) {
      const updated = await client.query(`UPDATE netshift_world_targets
        SET compromised_by_user_id = $2, compromised_by_username = $3, compromised_at = NOW(), updated_at = NOW()
        WHERE slug = $1
        RETURNING slug, name, domain, security_level, description, probe_count,
                  last_probed_by_username, last_probed_at, compromised_by_user_id, compromised_by_username, compromised_at`,
        [slug, req.session.user.id, req.session.user.username]);
      updatedTargetRow = updated.rows[0];
      await client.query(`UPDATE netshift_world_host_inventory SET last_intrusion_at=NOW(), next_regen_at=NOW()+INTERVAL '5 minutes', inventory_version=inventory_version+1 WHERE target_slug=$1`, [slug]);
      eventType = previousOwner ? 'target.reclaimed' : 'target.breached';
      resultText = previousOwner ? `Intrusion successful. You took control of ${current.name} from ${previousOwner}.` : `Intrusion successful. You now control ${current.name}.`;
    } else {
      eventType = 'target.breach-failed';
      resultText = `Intrusion blocked. ${current.name}'s security systems rejected the attempt.`;
    }
    await client.query(`INSERT INTO netshift_world_player_target_progress
      (user_id, target_slug, last_attack_at, last_attack_result)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (user_id, target_slug) DO UPDATE SET last_attack_at = NOW(), last_attack_result = EXCLUDED.last_attack_result`,
      [req.session.user.id, slug, succeeded ? 'success' : 'failure']);
    const summary = succeeded
      ? (previousOwner ? `${req.session.user.username} seized ${current.name} from ${previousOwner}.` : `${req.session.user.username} breached ${current.name}.`)
      : `${req.session.user.username} failed to breach ${current.name}; host security held.`;
    const eventResult = await client.query(`INSERT INTO netshift_world_events
      (actor_user_id, actor_username, event_type, target_slug, summary)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, actor_username, event_type, target_slug, summary, created_at`,
      [req.session.user.id, req.session.user.username, eventType, slug, summary]);
    const target = mapWorldTarget(updatedTargetRow);
    const event = mapWorldEvent({ ...eventResult.rows[0], target_name: current.name });
    await client.query('COMMIT');
    if (io) {
      io.to(WORLD_ROOM).emit('world:event', event);
      if (succeeded) io.to(WORLD_ROOM).emit('world:target-updated', target);
    }
    res.json({ ok: true, success: succeeded, chancePercent: successChance, result: resultText,
      target: { ...target, myProbeCount: Number(progressResult.rows[0].probe_count), myLastAttackAt: new Date().toISOString(), myLastAttackResult: succeeded ? 'success' : 'failure' }, event });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    next(error);
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0, setHeaders(res, filePath) { if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store'); } }));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'), error => error && next(error));
});

app.use((error, _req, res, _next) => {
  console.error('Request error:', error.stack || error.message || error);
  if (res.headersSent) return;
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid JSON request.' });
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

async function start() {
  await initialiseDatabase();
  httpServer = http.createServer(app);
  io = new SocketIOServer(httpServer, {
    serveClient: true,
    // The initial Render deployment is a single web-service instance. Before scaling
    // across instances, configure a shared Socket.IO adapter and sticky sessions.
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25000,
    pingTimeout: 20000
  });
  io.engine.use(netshiftSessionMiddleware);
  io.use(async (socket, next) => {
    try {
      const user = socket.request.session?.user;
      const sessionId = socket.request.sessionID;
      if (!user?.id || !user?.username) return next(new Error('Please sign in to join the shared network.'));
      const owner = await pool.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW()
        WHERE user_id = $1 AND session_id = $2 RETURNING user_id`, [user.id, sessionId]);
      if (!owner.rowCount) return next(new Error('This account session no longer owns access. Please sign in again.'));
      socket.data.user = safeUser(user);
      socket.data.sessionId = sessionId;
      next();
    } catch (error) { next(error); }
  });
  io.on('connection', socket => {
    const user = socket.data.user;
    socket.join(WORLD_ROOM);
    socket.join(sessionRoom(socket.data.sessionId));
    const userId = String(user.id);
    let entry = onlinePlayers.get(userId);
    if (!entry) {
      entry = { user, socketIds: new Set() };
      onlinePlayers.set(userId, entry);
    } else {
      entry.user = user;
    }
    entry.socketIds.add(socket.id);
    broadcastWorldPresence();

    socket.on('world:chat-send', async (payload, acknowledge) => {
      const ack = typeof acknowledge === 'function' ? acknowledge : () => {};
      const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
      if (!message) return ack({ ok: false, error: 'Write a message before sending.' });
      if (message.length > 300) return ack({ ok: false, error: 'Messages must be 300 characters or fewer.' });
      const now = Date.now();
      const times = (chatRateBuckets.get(userId) || []).filter(time => now - time < 10000);
      if (times.length >= 5) return ack({ ok: false, error: 'Chat rate limit: wait a few seconds before sending another message.' });
      times.push(now); chatRateBuckets.set(userId, times);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ownership = await client.query(`SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE`, [user.id]);
        if (!ownership.rowCount || ownership.rows[0].session_id !== socket.data.sessionId || socket.data.ownershipRevoked) {
          await client.query('ROLLBACK');
          return ack({ ok: false, error: 'This session no longer owns the account. Sign in again.' });
        }
        await client.query(`UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1`, [user.id]);
        const inserted = await client.query(`INSERT INTO netshift_world_chat (actor_user_id, actor_username, message)
          VALUES ($1, $2, $3) RETURNING id, actor_username, message, created_at`, [user.id, user.username, message]);
        const chatMessage = mapWorldChat(inserted.rows[0]);
        await client.query('COMMIT');
        io.to(WORLD_ROOM).emit('world:chat-message', chatMessage);
        ack({ ok: true, messageId: chatMessage.id });
        // Keep the persisted chat history bounded without deleting on every single message.
        if (Number(chatMessage.id) % 100 === 0) {
          pool.query(`DELETE FROM netshift_world_chat WHERE id < (
            SELECT id FROM netshift_world_chat ORDER BY id DESC OFFSET 1000 LIMIT 1
          )`).catch(error => console.error('Chat history pruning failed:', error.message));
        }
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('World chat save failed:', error.message);
        ack({ ok: false, error: 'Message could not be saved. Please try again.' });
      } finally { client.release(); }
    });

    socket.on('disconnect', () => {
      const current = onlinePlayers.get(userId);
      if (current) {
        current.socketIds.delete(socket.id);
        if (current.socketIds.size === 0) onlinePlayers.delete(userId);
      }
      broadcastWorldPresence();
    });
  });

  // Expire pending prompts even if the requesting browser disappears before polling again.
  const handoffSweeper = setInterval(async () => {
    try {
      const expired = await pool.query(`UPDATE netshift_login_handoffs SET status = 'expired', resolved_at = NOW()
        WHERE status = 'pending' AND expires_at <= NOW() RETURNING id, incumbent_session_id`);
      for (const row of expired.rows) emitToSession(row.incumbent_session_id, 'auth:handoff-expired', { handoffId: row.id });
    } catch (error) { console.error('Handoff expiry sweep failed:', error.message); }
  }, 30000);
  handoffSweeper.unref();

  // Coordinated database-timestamp-based world inventory refresh. Credential-bearing
  // hosts use a three-day lockout before their next ordinary five-minute regeneration.
  const worldRegenTicker = setInterval(async () => {
    try {
      await pool.query(`UPDATE netshift_world_host_inventory
        SET stock = COALESCE(stock, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'id', target_slug || '-warez1-' || floor(extract(epoch FROM NOW())/300)::bigint,
          'name','Warez Virus L1.vshare','type','software','family','warez','level',1)),
          money_cents = GREATEST(money_cents, 10000), inventory_version=inventory_version+1,
          next_regen_at = NOW() + INTERVAL '5 minutes'
        WHERE next_regen_at IS NOT NULL AND next_regen_at <= NOW()
          AND (credential_lock_until IS NULL OR credential_lock_until <= NOW())`);
    } catch (error) { console.error('World inventory regeneration failed:', error.message); }
  }, 30000);
  worldRegenTicker.unref();

  const shutdown = signal => {
    console.log(`${signal} received; closing NETSHIFT Online.`);
    io.close(() => {
      if (httpServer?.listening) httpServer.close(() => pool.end().finally(() => process.exit(0)));
      else pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  httpServer.listen(PORT, '0.0.0.0', () => console.log(`NETSHIFT Online listening on port ${PORT} (Socket.IO enabled)`));
}
start().catch(error => { console.error('NETSHIFT startup failed:', error.message); process.exit(1); });
