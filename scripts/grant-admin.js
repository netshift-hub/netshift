// Operator-run bootstrap utility. Never expose this as a web route.
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  const confirmation = process.env.NETSHIFT_ADMIN_GRANT_CONFIRM;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Usage: npm run admin:grant -- <existing-username>');
  if (confirmation !== `GRANT_ADMIN_TO:${username}`) throw new Error(`Set NETSHIFT_ADMIN_GRANT_CONFIRM=GRANT_ADMIN_TO:${username} for this one-time operation.`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query('SELECT id,username FROM netshift_users WHERE username=$1', [username]);
    if (!result.rowCount) throw new Error('User does not exist. Create and test the account first.');
    await pool.query(`INSERT INTO netshift_admin_roles(user_id,granted_by,mfa_required) VALUES($1,'operator-cli',TRUE)
      ON CONFLICT(user_id) DO NOTHING`, [result.rows[0].id]);
    await pool.query(`INSERT INTO netshift_admin_audit(actor_user_id,actor_username,action,subject_username,detail)
      VALUES(NULL,'operator-cli','grant-admin',$1,'{"method":"one-time operator CLI grant","mfa_required":true}'::jsonb)`, [username]);
    process.stdout.write(`Administrator role granted to ${username}. Configure MFA before using admin commands.\n`);
  } finally { await pool.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
