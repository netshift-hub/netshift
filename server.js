// NETSHIFT Online backend — user accounts, PostgreSQL sessions and per-user save slots.
require('dotenv').config();
const express = require('express');
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
  `);
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
app.use(session({
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
}));

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
    res.json({ ok: true, service: 'netshift-online', database: 'connected' });
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
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('netshift.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    res.json({ ok: true });
  });
});

app.get('/api/save', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT save_data, updated_at FROM netshift_saves WHERE user_id = $1', [req.session.user.id]);
    if (!result.rowCount) return res.json({ save: null, updatedAt: null });
    res.json({ save: result.rows[0].save_data, updatedAt: result.rows[0].updated_at });
  } catch (error) { next(error); }
});

app.post('/api/save', requireAuth, saveLimiter, async (req, res, next) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schemaVersion !== 1 ||
      !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) {
    return res.status(400).json({ error: 'The game save is invalid or uses an unsupported version.' });
  }
  // Defend against oversized or malformed snapshots. The client is not authoritative for
  // competitive multiplayer: this v1 stores a private per-account save, not a trusted simulation.
  let serialised;
  try { serialised = JSON.stringify(payload); }
  catch (_error) { return res.status(400).json({ error: 'The game save could not be serialised.' }); }
  if (Buffer.byteLength(serialised, 'utf8') > 3 * 1024 * 1024) {
    return res.status(413).json({ error: 'Save data is too large (maximum 3 MB).' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO netshift_saves (user_id, save_data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE SET save_data = EXCLUDED.save_data, updated_at = NOW()
      RETURNING updated_at
    `, [req.session.user.id, serialised]);
    res.json({ ok: true, updatedAt: result.rows[0].updated_at });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));
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
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`NETSHIFT Online listening on port ${PORT}`));
  const shutdown = signal => {
    console.log(`${signal} received; closing NETSHIFT Online.`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
start().catch(error => { console.error('NETSHIFT startup failed:', error.message); process.exit(1); });
