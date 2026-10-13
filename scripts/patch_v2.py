from pathlib import Path
p=Path('/mnt/data/work_v2/server.js')
s=p.read_text()
needle='''    CREATE INDEX IF NOT EXISTS netshift_world_chat_created_idx
      ON netshift_world_chat (created_at DESC, id DESC);
  `);'''
insert='''    CREATE INDEX IF NOT EXISTS netshift_world_chat_created_idx
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
  `);'''
assert needle in s
s=s.replace(needle,insert)
# Add helper functions before app declaration
needle='const app = express();'
helpers=r'''
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
'''
s=s.replace(needle,helpers+'\n'+needle)
# banned login check after user fetched and password verified
old="""    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Sign-in failed. Check your username and password.' });
    }
    // Regenerate first"""
new="""    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Sign-in failed. Check your username and password.' });
    }
    const ban = await pool.query('SELECT reason FROM netshift_user_bans WHERE user_id = $1', [user.id]);
    if (ban.rowCount) return res.status(403).json({ error: 'This account is banned.', code: 'ACCOUNT_BANNED' });
    // Regenerate first"""
assert old in s
s=s.replace(old,new)
# after acquired in login, ensure player world
s=s.replace("if (ownership.kind === 'acquired') return res.json({ user: safeUser(user) });", "if (ownership.kind === 'acquired') { await ensurePlayerWorld(user); return res.json({ user: safeUser(user) }); }")
# after registration ownership acquired
s=s.replace("""    if (ownership.kind !== 'acquired') {
      await destroyRequestSession(req, res);""", """    if (ownership.kind !== 'acquired') {
      await destroyRequestSession(req, res);""")
s=s.replace("""    res.status(201).json({ user: safeUser(result.rows[0]) });""", """    await ensurePlayerWorld(result.rows[0]);
    res.status(201).json({ user: safeUser(result.rows[0]) });""")
# Add APIs before shared multiplayer comment
needle='// Shared multiplayer foundation: this initial slice shares public target metadata and'
api=r'''
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
      res.json({ ok: true, welcomeBonus: 5, currency: 'USD', message: 'First Bank account activated. The one-time $500 welcome bonus is included in your opening balance.' });
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
    const parentExists = parent === '/' || (await pool.query(`SELECT 1 FROM netshift_player_files WHERE user_id=$1 AND name=$2 AND item_type='folder' AND deleted_at IS NULL`, [req.session.user.id, parent.split('/').filter(Boolean).at(-1)])).rowCount;
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
      await c.query('UPDATE netshift_world_host_inventory SET stock=$2::jsonb, inventory_version=inventory_version+1 WHERE target_slug=$1', [req.params.slug, JSON.stringify(updated)]);
      await c.query(`INSERT INTO netshift_world_loot_claims (target_slug,item_key,claimed_by_user_id,regen_after) VALUES ($1,$2,$3,NOW()+INTERVAL '5 minutes')`, [req.params.slug, item.id, req.session.user.id]);
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

'''
assert needle in s
s=s.replace(needle,api+needle)
# Seed shared inventory after target seeding loop. add after loop close before initialiseDatabase closes (unique text)
needle="""    `, [target.slug, target.name, target.domain, target.securityLevel, target.description]);
  }
}"""
repl="""    `, [target.slug, target.name, target.domain, target.securityLevel, target.description]);
    const stock = [
      { id: `${target.slug}-readme`, name: 'README.txt', type: 'file', content: `Public files for ${target.name}.` },
      { id: `${target.slug}-warez1`, name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1 }
    ];
    await pool.query(`INSERT INTO netshift_world_host_inventory(target_slug,stock,money_cents)
      VALUES($1,$2::jsonb,$3) ON CONFLICT(target_slug) DO NOTHING`, [target.slug, JSON.stringify(stock), target.securityLevel <= 1 ? 25000 : 10000]);
  }
}"""
assert needle in s
s=s.replace(needle,repl)
# Add periodic regeneration scheduler after handoffSweeper interval setup
needle="""  handoffSweeper.unref();

  const shutdown = signal => {"""
repl="""  handoffSweeper.unref();

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

  const shutdown = signal => {"""
assert needle in s
s=s.replace(needle,repl)
p.write_text(s)
