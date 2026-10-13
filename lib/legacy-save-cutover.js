'use strict';

/**
 * One-time, transactional retirement of the pre-server-authoritative save blob.
 *
 * Deliberately touches only netshift_saves. Accounts, profiles, bank accounts,
 * canonical player files/software, world progress, host stock/claims and admin
 * records are outside this reset's deletion scope.
 */
const LEGACY_SAVE_CUTOVER_KEY = 'stage1-legacy-save-reset-v1';
const LEGACY_SAVE_CUTOVER_LOCK_NAMESPACE = 741103;
const LEGACY_SAVE_CUTOVER_LOCK_ID = 1;
const CURRENT_SAVE_SCHEMA_VERSION = 2;

function isRetiredLegacySave(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
    && payload.schemaVersion === 1);
}

async function applyLegacySaveCutover(pool) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    // Transaction-scoped lock serialises app instances racing to apply this reset.
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
      LEGACY_SAVE_CUTOVER_LOCK_NAMESPACE,
      LEGACY_SAVE_CUTOVER_LOCK_ID
    ]);

    const existing = await client.query(
      'SELECT migration_key FROM netshift_migration_receipts WHERE migration_key = $1 FOR UPDATE',
      [LEGACY_SAVE_CUTOVER_KEY]
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { applied: false, deletedSaveCount: 0, migrationKey: LEGACY_SAVE_CUTOVER_KEY };
    }

    // Discard schema-v1 and malformed/unknown legacy documents, but preserve any
    // already-created schema-v2 document if this migration is ever applied later.
    const deleted = await client.query(
      `DELETE FROM netshift_saves WHERE save_data->>'schemaVersion' IS DISTINCT FROM $1`,
      [String(CURRENT_SAVE_SCHEMA_VERSION)]
    );
    await client.query(`
      INSERT INTO netshift_migration_receipts (migration_key, description, details)
      VALUES ($1, $2, $3::jsonb)
    `, [
      LEGACY_SAVE_CUTOVER_KEY,
      'Discard legacy/unknown game saves; preserve schema-v2 documents and dedicated server records.',
      JSON.stringify({
        action: 'delete_legacy_or_unknown_save_rows',
        schemaVersionRetired: 1,
        currentSaveSchemaVersion: CURRENT_SAVE_SCHEMA_VERSION,
        canonicalTablesTouched: [],
        purchaseOrLedgerRowsCreated: 0
      })
    ]);

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      applied: true,
      deletedSaveCount: Number(deleted.rowCount || 0),
      migrationKey: LEGACY_SAVE_CUTOVER_KEY
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (_) { /* Keep the migration error. */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  CURRENT_SAVE_SCHEMA_VERSION,
  LEGACY_SAVE_CUTOVER_KEY,
  applyLegacySaveCutover,
  isRetiredLegacySave
};
