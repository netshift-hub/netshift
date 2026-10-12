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

const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

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
const onlinePlayers = new Map(); // user ID -> { user, socketIds:Set }; session-scoped sockets are tracked separately.
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
    lastProbedAt: row.last_probed_at || null
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
async function readWorldSnapshot() {
  const [targetResult, eventResult] = await Promise.all([
    pool.query(`SELECT slug, name, domain, security_level, description, probe_count,
                       last_probed_by_username, last_probed_at
                FROM netshift_world_targets ORDER BY security_level, name`),
    pool.query(`SELECT e.id, e.actor_username, e.event_type, e.target_slug, e.summary, e.created_at,
                       t.name AS target_name
                FROM netshift_world_events e
                LEFT JOIN netshift_world_targets t ON t.slug = e.target_slug
                ORDER BY e.created_at DESC, e.id DESC LIMIT 30`)
  ]);
  return {
    players: worldOnlineList(),
    targets: targetResult.rows.map(mapWorldTarget),
    events: eventResult.rows.map(mapWorldEvent),
    updatedAt: new Date().toISOString()
  };
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
const netshiftSessionMiddleware = session({
  name: 'netshift.sid',
  store: new PgSessionStore({ pool, tableName: 'netshift_sessions', createTableIfMissing: false }),
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

function safeUser(user) { return { id: String(user.id), username: user.username }; }
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}
function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(username);
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}
function setSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.user = safeUser(user);
      req.session.save(saveError => saveError ? reject(saveError) : resolve());
    });
  });
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

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'Choose a username of 3–20 letters, numbers or underscores.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Choose a password between 12 and 128 characters.' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO netshift_users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.toLowerCase(), passwordHash]
    );
    await setSession(req, result.rows[0]);
    res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!validUsername(username) || password.length < 1 || password.length > 128) {
    return res.status(400).json({ error: 'Enter a valid username and password.' });
  }
  try {
    const result = await pool.query('SELECT id, username, password_hash FROM netshift_users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Sign-in failed. Check your username and password.' });
    }
    await setSession(req, user);
    res.json({ user: safeUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res, next) => {
  const sessionId = req.sessionID;
  req.session.destroy(error => {
    if (error) return next(error);
    // Close only sockets authenticated with the session being logged out. Other
    // browser sessions for this account remain independent and presence is recalculated.
    if (io) {
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionId === sessionId) socket.disconnect(true);
      }
    }
    res.clearCookie('netshift.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    res.json({ ok: true });
  });
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

// Shared multiplayer foundation: this initial slice shares public target metadata and
// server-recorded probe events. It deliberately does not share bank balances or accept
// client-authored money/hack outcomes; those mechanics need separate authoritative commands.
app.get('/api/world/summary', requireAuth, async (_req, res, next) => {
  try { res.json(await readWorldSnapshot()); }
  catch (error) { next(error); }
});

app.post('/api/world/targets/:slug/probe', requireAuth, worldProbeLimiter, async (req, res, next) => {
  const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return res.status(400).json({ error: 'Invalid target identifier.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`
      UPDATE netshift_world_targets
      SET probe_count = probe_count + 1,
          last_probed_by_user_id = $2,
          last_probed_by_username = $3,
          last_probed_at = NOW(),
          updated_at = NOW()
      WHERE slug = $1
      RETURNING slug, name, domain, security_level, description, probe_count,
                last_probed_by_username, last_probed_at
    `, [slug, req.session.user.id, req.session.user.username]);
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That shared target was not found.' });
    }

    const target = mapWorldTarget(updated.rows[0]);
    const summary = `${req.session.user.username} probed ${target.name} (${target.domain}).`;
    const inserted = await client.query(`
      INSERT INTO netshift_world_events (actor_user_id, actor_username, event_type, target_slug, summary)
      VALUES ($1, $2, 'target.probed', $3, $4)
      RETURNING id, actor_username, event_type, target_slug, summary, created_at
    `, [req.session.user.id, req.session.user.username, target.slug, summary]);
    const event = mapWorldEvent({ ...inserted.rows[0], target_name: target.name });
    await client.query('COMMIT');

    // Broadcast only server-created, allowlisted event/target fields to authenticated clients.
    if (io) {
      io.to(WORLD_ROOM).emit('world:event', event);
      io.to(WORLD_ROOM).emit('world:target-updated', target);
    }
    res.json({ ok: true, target, event, result: 'Probe recorded in the shared network activity log.' });
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
  io.use((socket, next) => {
    const user = socket.request.session?.user;
    if (!user?.id || !user?.username) return next(new Error('Please sign in to join the shared network.'));
    socket.data.user = safeUser(user);
    socket.data.sessionId = socket.request.sessionID;
    next();
  });
  io.on('connection', socket => {
    const user = socket.data.user;
    socket.join(WORLD_ROOM);
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

    socket.on('disconnect', () => {
      const current = onlinePlayers.get(userId);
      if (current) {
        current.socketIds.delete(socket.id);
        if (current.socketIds.size === 0) onlinePlayers.delete(userId);
      }
      broadcastWorldPresence();
    });
  });

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
